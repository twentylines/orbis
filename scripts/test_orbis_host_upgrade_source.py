import copy
import contextlib
import io
import subprocess
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace, ModuleType
import unittest
from unittest import mock
import uuid

HERE=Path(__file__).resolve().parent
CORE=HERE.parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

L=load('upgrade_launcher_tests',HERE/'orbis-host-upgrade-launcher.py')
S=load('upgrade_source_supervision',HERE/'orbis-host-upgrade-supervision.py')
BOOT=load('upgrade_source_boot',CORE/'scripts/install-orbis.py')
BUILD=load('upgrade_source_build',CORE/'scripts/orbis-installer-bundle.py')
PLAN=load('upgrade_source_plan',CORE/'scripts/orbis-release-plan.py')
SETUP=load('upgrade_checked_setup',CORE/'scripts/orbis-host-service-setup.py')
GUIDE=load('upgrade_checked_guide',CORE/'scripts/orbis-install.py')
UPGRADE=load('upgrade_owned_helper',CORE/'scripts/orbis-host-service-upgrade.py')
RUNNER=load('upgrade_return_reader',CORE/'scripts/orbis-host-upgrade-runner.py')
COMMIT='bd621739baf3d4edd2742ec75058007933ebd80f'


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_files={str(path.relative_to(CORE)):path.read_bytes() for path in (CORE/'scripts').iterdir()
                        if BUILD.ALLOWED.fullmatch(str(path.relative_to(CORE)))}
        cls.base_files['packaging/systemd/orbis-host.service']=(CORE/'packaging/systemd/orbis-host.service').read_bytes()

    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name)
        self.operation=str(uuid.uuid4());self.state=self.root/'state';self.state.mkdir(mode=0o700)
        S.operation_directory(self.state,self.operation).mkdir(mode=0o700,parents=True)
        self.target={'schema':'orbis.release.v1','tag':'v0.9.2','commit':COMMIT,
                     'image':'ghcr.io/twentylines/orbis','digest':'sha256:'+'a'*64,
                     'installationProtocol':'orbis.installation-state.v1','runtipiCompatibility':'4.10.1'}
        self.files=dict(self.base_files)
        self.build_inputs()
        self.calls=[]
        self.scope=SimpleNamespace(operation=self.operation,request_sha='d'*64,target=copy.deepcopy(self.target),
            channel='stable',state_directory=self.state,supervision=S,verify_bootstrap=mock.Mock())
        self.scope.verify_bootstrap.return_value={'invocationId':'c'*32}
        for patch in (mock.patch.object(L,'operator',return_value=None),mock.patch.object(L,'OWNER',os.geteuid()),
                      mock.patch.object(SETUP.HOST.AUTHORITY,'OWNER',os.geteuid()),mock.patch.object(BOOT,'fetch',side_effect=self.fetch),
                      mock.patch.object(BOOT,'private_directory',side_effect=self.private_directory)):
            patch.start();self.addCleanup(patch.stop)

    def private_directory(self,path):
        path.mkdir(mode=0o700,parents=True,exist_ok=True)
        return path

    def build_inputs(self, published=None):
        self.core_body=json.dumps(self.target if published is None else published).encode()
        self.assets=BUILD.build(self.files,self.core_body)
        identity={'tag':self.target['tag'],'commit':self.target['commit'],'manifestSha256':BOOT.sha(self.assets[BOOT.MANIFEST])}
        self.launcher=BOOT._render_installer('release',identity,self.files['scripts/install-orbis.py'])
        self.tree={'sha':'f'*40,'truncated':False,'tree':[{'path':name,'mode':'100644','type':'blob',
            'sha':L.git_blob(body),'size':len(body)} for name,body in self.files.items()]}

    def fetch(self,url,limit):
        self.calls.append(url)
        base=L.RELEASES+self.target['tag']+'/'
        mapping={base+'install-orbis.py':self.launcher,base+BOOT.MANIFEST:self.assets[BOOT.MANIFEST],
                 base+'release-manifest.json':self.core_body,base+BOOT.ARCHIVE:self.assets[BOOT.ARCHIVE],
                 L.GITHUB+'git/commits/'+self.target['commit']:json.dumps({'sha':self.target['commit'],'tree':{'sha':'f'*40}}).encode(),
                 L.GITHUB+'git/trees/'+'f'*40+'?recursive=1':json.dumps(self.tree).encode()}
        self.assertIn(url,mapping)
        return mapping[url]

    def stage(self):
        return L.stage_source(BOOT,PLAN,S,self.scope,self.state,self.operation,'d'*64,self.target,'stable')

    def test_real_bundle_verification_stages_every_member_without_execution_or_forged_receipt(self):
        with mock.patch.object(BOOT,'_exec_verified_installer') as execute:
            staged=self.stage()
        execute.assert_not_called()
        staged.verify()
        self.assertEqual(staged.members,frozenset(BUILD.sources(self.files)))
        self.assertEqual(len(self.calls),6)
        self.assertGreater(self.scope.verify_bootstrap.call_count,12)
        self.assertFalse((staged.directory/BOOT.SOURCE_EXECUTION).exists())
        self.assertEqual(L.decoded(staged.descriptor)['core'],self.target)
        self.assertEqual(L.decoded(staged.descriptor)['gitTreeSha'],'f'*40)

    def test_qualified_manifest_keeps_the_same_verified_installer_receipt(self):
        from urllib.error import HTTPError

        self.target['runtipiCompatibility'] = '4.12.0'
        self.scope.target = copy.deepcopy(self.target)
        self.build_inputs()
        base = L.RELEASES + self.target['tag'] + '/'

        def fetch(url, limit):
            if url == base + BOOT.CORE_MANIFEST:
                raise HTTPError(url, 404, 'unavailable to legacy clients', {}, None)
            if url == base + BOOT.QUALIFIED_CORE_MANIFEST:
                return self.core_body
            return self.fetch(url, limit)

        with mock.patch.object(BOOT, 'fetch', side_effect=fetch) as reads:
            staged = self.stage()
        staged.verify()
        self.assertEqual(L.decoded(staged.descriptor)['core'], self.target)
        self.assertEqual((staged.directory / BOOT.CORE_MANIFEST).read_bytes(), self.core_body)
        reads.assert_any_call(base + BOOT.QUALIFIED_CORE_MANIFEST, 16 * 1024)

    def package_with_git_proof(self):
        repository = self.root / 'proof-source'
        repository.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null',
                                            '-c', 'commit.gpgSign=false', *args], cwd=repository)
        git('init', '--quiet')
        for name, body in self.files.items():
            path = repository / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        git('add', '--all')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Source proof fixture')
        self.target['commit'] = git('rev-parse', 'HEAD').decode().strip()
        self.scope.target = copy.deepcopy(self.target)
        self.core_body = json.dumps(self.target).encode()
        self.assets = BUILD.build(self.files, self.core_body, repository=repository)
        self.launcher = self.assets[BUILD.LAUNCHER]
        return git('rev-parse', 'HEAD^{tree}').decode().strip()

    def test_published_git_proof_authenticates_archive_without_the_github_api(self):
        tree = self.package_with_git_proof()
        staged = self.stage()
        self.assertEqual(len(self.calls), 4)
        self.assertTrue(all(url.startswith(L.RELEASES) for url in self.calls))
        self.assertEqual(L.decoded(staged.descriptor)['gitTreeSha'], tree)
        self.assertFalse((staged.directory / BOOT.SOURCE_EXECUTION).exists())

    def test_invalid_included_proof_refuses_without_api_fallback_or_selection(self):
        self.package_with_git_proof()
        manifest = json.loads(self.assets[BOOT.MANIFEST])
        proof = manifest[L.GIT_PROOF_FIELD]
        values = BUILD.sources(self.files)
        changed = {**values, 'scripts/orbis-install.py': b'changed member bytes'}
        with self.assertRaises(L.UpgradeSourceError):
            L.authenticate_embedded_tree(proof, self.target['commit'], changed)
        with self.assertRaises(L.UpgradeSourceError):
            L.authenticate_embedded_tree(proof, 'f' * 40, values)
        manifest[L.GIT_PROOF_FIELD] = 'attacker supplied proof'
        self.assets[BOOT.MANIFEST] = L.canonical(manifest)
        identity = {'tag': self.target['tag'], 'commit': self.target['commit'],
                    'manifestSha256': BOOT.sha(self.assets[BOOT.MANIFEST])}
        self.launcher = BOOT._render_installer('release', identity, self.files['scripts/install-orbis.py'])
        with self.assertRaises(L.UpgradeSourceError):
            self.stage()
        self.assertEqual(len(self.calls), 4)
        self.assertFalse((S.operation_directory(self.state, self.operation) / 'selection').exists())

    def produce_execution(self, staged, stdout):
        value=L.decoded(staged.descriptor)
        launcher=staged.directory/BOOT.SOURCE_LAUNCHER
        identity=L.literal(launcher.read_bytes(),'EXPECTED_RELEASE')
        def guided(destination,channel,remaining,selection):
            expected=['--verify-upgrade-source'] if value['sourceProtocol'] else ['--help']
            self.assertEqual(remaining,expected)
            if value['sourceProtocol']:
                output=io.StringIO()
                with mock.patch.object(GUIDE,'__file__',str(destination/'scripts/orbis-install.py')), \
                        mock.patch.object(GUIDE,'load',return_value=SETUP), \
                        mock.patch.object(GUIDE.SENTINEL,'require_host'),contextlib.redirect_stdout(output):
                    self.assertEqual(GUIDE.verify_upgrade_source(SimpleNamespace(channel=channel),selection),0)
                os.write(stdout,output.getvalue().encode())
            else:
                os.write(stdout,b'usage: legacy guided installer\n')
        with launcher.open('rb') as held:
            selected=ModuleType('selected_source_launcher')
            selected.__file__=f'/proc/self/fd/{held.fileno()}'
            exec(compile(launcher.read_bytes(),selected.__file__,'exec'),selected.__dict__)
            selected.OWNER=os.geteuid()
            selected.private_directory=self.private_directory
            selected._exec_guided=guided
            selected._continue_verified_installer([str(staged.directory),value['selectionSha256'],'stable',
                '--verify-upgrade-source' if value['sourceProtocol'] else '--help'])

    def execute(self,staged,*,after=None,code=0):
        original_loader=L.load_sibling
        def modules(name,key):
            return SETUP if name=='orbis-host-service-setup.py' else original_loader(name,key)
        def child(command,**options):
            self.assertEqual(command,L.source_child_argv(S,self.state,self.operation))
            self.assertNotIn('pass_fds',options)
            self.assertNotIn('HOME',options['env'])
            self.produce_execution(staged,options['stdout'])
            if after:after()
            return subprocess.CompletedProcess(command,code)
        with mock.patch.object(L,'load_sibling',side_effect=modules),mock.patch.object(L.subprocess,'run',side_effect=child):
            return L.execute_source(staged)

    def test_parent_keeps_ownership_and_uses_genuine_receipt_after_source_only_child(self):
        staged=self.stage()
        checked=self.execute(staged)
        self.assertEqual(checked['core'],self.target)
        self.assertEqual(checked['sourceProtocol'],L.PROTOCOL)
        proof=L.decoded((staged.directory/BOOT.SOURCE_EXECUTION).read_bytes())
        self.assertEqual(proof['selectionSha256'],checked['selectionSha256'])
        self.assertEqual(checked['executionSha256'],L.sha((staged.directory/BOOT.SOURCE_EXECUTION).read_bytes()))
        self.assertTrue((staged.directory.parent/'source-checked.json').exists())
        with self.assertRaises(L.UpgradeSourceError):L.execute_source(staged)

    def test_legacy_genuine_continuation_can_check_source_without_injecting_protocol(self):
        previous=COMMIT
        self.files=BUILD.committed_files(CORE,previous)
        self.target={**self.target,'tag':'v0.9.2-rc.10','commit':previous}
        self.scope.target=copy.deepcopy(self.target)
        self.build_inputs()
        with self.assertRaises(L.UpgradeSourceError):self.stage()
        staged=L.stage_source(BOOT,PLAN,S,self.scope,self.state,self.operation,'d'*64,self.target,'stable',legacy=True)
        checked=self.execute(staged)
        self.assertIsNone(checked['sourceProtocol'])
        self.assertTrue((staged.directory/BOOT.SOURCE_EXECUTION).exists())
        self.assertNotIn(b'UPGRADE_SOURCE_CHECK_PROTOCOL',(staged.directory/'scripts/orbis-install.py').read_bytes())

    def test_release_without_genuine_execution_custody_cannot_be_adopted(self):
        previous='6b627e1939e11e91fbd5c6ed419e1e90a71cf281'
        self.files=BUILD.committed_files(CORE,previous)
        self.target={**self.target,'tag':'v0.9.1','commit':previous}
        self.scope.target=copy.deepcopy(self.target)
        self.build_inputs()
        self.assertFalse(BOOT._custody_template(self.files['scripts/install-orbis.py']))
        with mock.patch.object(BOOT,'_exec_verified_installer') as execute:
            with self.assertRaises(L.UpgradeSourceError):
                L.stage_source(BOOT,PLAN,S,self.scope,self.state,self.operation,'d'*64,self.target,'stable',legacy=True)
            execute.assert_not_called()
        self.assertFalse((S.operation_directory(self.state,self.operation)/'selection').exists())

    def test_failed_child_or_changed_source_cannot_publish_checked_receipt(self):
        staged=self.stage()
        with self.assertRaises(L.UpgradeSourceError):self.execute(staged,code=1)
        self.assertFalse((staged.directory.parent/'source-checked.json').exists())
        with self.assertRaises(L.UpgradeSourceError):L.execute_source(staged)

    def test_source_check_timeout_preserves_evidence_without_permitting_a_retry(self):
        staged=self.stage()
        with mock.patch.object(L.subprocess,'run',side_effect=subprocess.TimeoutExpired('source-check',120)):
            with self.assertRaises(L.UpgradeSourceError):L.execute_source(staged)
        self.assertTrue((staged.directory.parent/'source-preparation.json').exists())
        self.assertFalse((staged.directory.parent/'source-checked.json').exists())
        self.assertFalse((staged.directory/BOOT.SOURCE_EXECUTION).exists())
        with self.assertRaises(L.UpgradeSourceError):L.execute_source(staged)

    def test_source_changes_after_the_child_are_not_adopted_as_original_inputs(self):
        staged=self.stage()
        path=staged.directory/'scripts/orbis-host-service.py'
        with self.assertRaises(L.UpgradeSourceError):
            self.execute(staged,after=lambda:path.write_bytes(path.read_bytes()+b'\n'))
        self.assertFalse((staged.directory.parent/'source-checked.json').exists())

    @contextlib.contextmanager
    def target_hold(self, staged, checked):
        self.scope.directory=staged.directory.parent
        original=L.load_sibling
        with mock.patch.object(L,'load_sibling',side_effect=lambda name,key:
                SETUP if name=='orbis-host-service-setup.py' else original(name,key)):
            with L.hold_worker_target(self.scope,checked) as admission:
                yield admission

    def test_actual_execution_binds_every_host_member_and_exact_sentinel_toolkit(self):
        staged=self.stage();checked=self.execute(staged)
        with self.target_hold(staged,checked) as admission:
            value=admission.target.manifest()
            self.assertEqual(value['core'],self.target)
            self.assertEqual(value['sourceExecutionSha256'],checked['executionSha256'])
            self.assertEqual(set(value['host']['inventory']),set(SETUP.SCRIPTS))
            self.assertIn('install-orbis.py',value['host']['inventory'])
            self.assertIn('orbis-host-upgrade-target.py',value['host']['inventory'])
            self.assertEqual(value['sentinel']['release'],L.literal(self.files['scripts/orbis-sentinel-install.py'],'RELEASE'))
            self.assertEqual(value['sentinel']['toolkitCommit'],L.literal(self.files['scripts/orbis-sentinel-install.py'],'TOOLKIT_COMMIT'))
            self.assertEqual(set(value['sentinel']['toolkit']),{'activate_release.py','stage_release.py','verify_release.py','bootstrap_verifier.py','LICENSE'})
            admission.verify_bootstrap()
        with self.assertRaises(ValueError):admission.verify_bootstrap()

    def test_published_manifest_keeps_full_source_custody_with_a_compact_job_identity(self):
        self.target={**self.target,'runtipiCompatibility':'4.12.0'}
        self.scope.target=copy.deepcopy(self.target)
        self.build_inputs({**self.target,'releaseChannel':'stable','updatePriority':'normal','criticalThrough':None,
            'criticalFixes':[],'platforms':['linux/amd64','linux/arm64'],'dataCompatibility':'orbis.data.v1',
            'accountIdentifierCompatibility':'orbis.account-identifier.v1','migrationFingerprint':'sha256:'+'b'*64})
        staged=self.stage()
        checked=self.execute(staged)
        with self.target_hold(staged,checked) as admission:
            self.assertEqual(admission.target.manifest()['core'],self.target)
            self.assertEqual((staged.directory/'release-manifest.json').read_bytes(),self.core_body)

    def test_target_copy_replacement_revokes_admission_even_with_equal_bytes(self):
        staged=self.stage();checked=self.execute(staged)
        with self.target_hold(staged,checked) as admission:
            path=self.scope.directory/'target-set.json'
            replacement=path.with_name('replacement.json')
            replacement.write_bytes(path.read_bytes());replacement.chmod(0o600)
            replacement.replace(path)
            with self.assertRaises(ValueError):admission.verify_bootstrap()

    def test_changed_host_member_revokes_target_before_next_effect(self):
        staged=self.stage();checked=self.execute(staged)
        effect=mock.Mock()
        with self.assertRaises(ValueError),self.target_hold(staged,checked) as admission:
            member=staged.directory/'scripts/orbis-host-service.py'
            member.write_bytes(member.read_bytes()+b'\n')
            admission.verify_bootstrap()
            effect()
        effect.assert_not_called()

    def test_forged_source_check_cannot_create_a_component_target(self):
        staged=self.stage();checked=self.execute(staged)
        with self.assertRaises(ValueError),self.target_hold(staged,{**checked,'executionSha256':'a'*64}):
            self.fail('Changed execution digest was accepted')
        self.assertFalse((staged.directory.parent/'target-set.json').exists())

    @contextlib.contextmanager
    def owned_helper(self):
        staged=self.stage();checked=self.execute(staged)
        installation=self.root/'installation';installation.mkdir(mode=0o700)
        frame={'pid':os.getpid(),'bootId':str(uuid.uuid4()),'startTime':1,'invocationId':'c'*32,
               'unit':S.unit_name(self.operation),'unitSha256':'b'*64}
        self.scope.verify_bootstrap.return_value=frame
        reference={'schema':L.WORKER_SCHEMA,'unit':frame['unit'],'requestSha256':'d'*64}
        job={'id':self.operation,'state':'running','worker':reference,'snapshot':str(self.root/'snapshot')}
        self.scope.intake={'root':str(installation),'dockerContext':'default',
                          'job':{key:value for key,value in job.items() if key!='worker'}}
        self.scope.accepted_job=lambda:copy.deepcopy(self.scope.intake['job'])
        L.write_exclusive(self.state/'job.json',L.canonical(job))
        for name,schema in [('claim.json','orbis.host-upgrade-claim.v1'),
                            ('execution-intent.json','orbis.host-upgrade-execution.v1')]:
            L.write_exclusive(staged.directory.parent/name,L.canonical({'schema':schema,'requestSha256':'d'*64,**frame}))
        original=UPGRADE.SETUP.load_script
        with self.target_hold(staged,checked) as admission:
            L.admit_helper_replacement(admission)
            with mock.patch.object(L,'Bootstrap',return_value=self.scope), \
                    mock.patch.object(UPGRADE,'STATE_DIR',self.state), \
                    mock.patch.object(UPGRADE.SETUP,'load_script',side_effect=lambda name,key:
                        L if name=='orbis-host-upgrade-launcher.py' else original(name,key)):
                yield installation,job,admission

    def test_helper_admits_only_its_actual_parent_job_after_host_intent(self):
        with self.owned_helper() as (root,job,admission):
            self.assertEqual(UPGRADE.job_identity(root,'default'),(self.operation,'running'))
            with self.assertRaises(ValueError):UPGRADE.job_identity()
            with self.assertRaises(ValueError):UPGRADE.job_identity(root,'different')
            with self.assertRaises(ValueError):UPGRADE.job_identity(root.parent,'default')
            self.scope.verify_bootstrap.side_effect=L.UpgradeSourceError()
            with self.assertRaises(ValueError):UPGRADE.job_identity(root,'default')

    def test_helper_job_admission_rechecks_host_intent_and_forbids_core_transaction(self):
        with self.owned_helper() as (root,job,admission):
            intent=self.scope.directory/'host-forward-intent.json'
            original=intent.read_bytes()
            changed=L.decoded(original);changed['invocationId']='e'*32
            intent.write_bytes(L.canonical(changed))
            with self.assertRaises(ValueError):UPGRADE.job_identity(root,'default')
            intent.write_bytes(original)
            update=load('owned_helper_update',HERE/'orbis-host-update.py')
            journal=update.journal_path(Path(job['snapshot']))
            journal.write_bytes(b'{}')
            with self.assertRaises(ValueError):UPGRADE.job_identity(root,'default')
            journal.unlink()
            intent.unlink()
            self.assertEqual(UPGRADE.job_identity(root,'default',preparing=True),(self.operation,'running'))
            with self.assertRaises(FileNotFoundError):UPGRADE.job_identity(root,'default')

    def test_helper_owned_job_never_bypasses_package_or_restart_holds(self):
        with self.owned_helper() as (root,job,admission):
            package=self.state/'package-job.json'
            package.write_bytes(L.canonical({'state':'running'}))
            with self.assertRaisesRegex(ValueError,'host package'):UPGRADE.job_identity(root,'default')
            package.unlink()
            restart=self.state/'restart-job.json'
            restart.write_bytes(L.canonical({'state':'restarting','bootId':'current'}))
            with mock.patch.object(UPGRADE.SERVICE,'boot_id',return_value='current'):
                with self.assertRaisesRegex(ValueError,'server restart'):UPGRADE.job_identity(root,'default')

    def test_host_effect_intent_is_exclusive_and_source_bound(self):
        with self.assertRaises(ValueError), self.owned_helper() as (root,job,admission):
            with self.assertRaises(FileExistsError):L.admit_helper_replacement(admission)
            before=(self.scope.directory/'host-forward-intent.json').read_bytes()
            member=self.scope.directory/'selection/scripts/orbis-host-service.py'
            member.write_bytes(member.read_bytes()+b'\n')
            with self.assertRaises(ValueError):UPGRADE.job_identity(root,'default')
            self.assertEqual((self.scope.directory/'host-forward-intent.json').read_bytes(),before)

    @contextlib.contextmanager
    def owned_return(self):
        with self.owned_helper() as (root, job, admission):
            job.update(current={**self.target, 'digest':'sha256:'+'b'*64}, target=self.target)
            self.scope.intake['job']={key:value for key,value in job.items() if key!='worker'}
            self.scope.intake.update(files={'legacy.py':'e'*64}, acceptingHostUnitSha256='f'*64)
            (self.state/'job.json').write_bytes(L.canonical(job))
            original={'core':{}, 'host':{'inventorySha256':RUNNER.sha(RUNNER.encoded(self.scope.intake['files'])),
                         'unitSha256':'f'*64,'observerProfile':None},
                      'sentinel':{'release':{'version':'prior-fixture'},'profile':None,'inventorySha256':'a'*64,'host':{}}}
            plan={'requestSha256':self.scope.request_sha,'targetSetSha256':RUNNER.sha(admission.body),
                  'target':admission.target.manifest(),'original':original}
            binding={'operationId':job['id'],'planSha256':RUNNER.sha(RUNNER.encoded(plan)),
                     'targetDigest':job['target']['digest']}
            retained={'schema':'fixture-retention',**binding}
            journal=RUNNER.Journal(L,admission)
            for phase,value in [
                ('staged',plan),('sentinel-ready',{}),('integration-prepared',{}),('integration-ready',{}),
                ('host-ready',{'retention':retained}),('integration-returned',{'restored':True,'profile':None}),
                ('sentinel-returned',{'restored':True,'previousRelease':original['sentinel']['release']}),
                ('host-return-intent',{'retention':retained,'originalCore':{'stage':'not-started','journalSha256':None},
                                       'sentinel':original['sentinel']})]:
                journal.append(phase,value)
            update=SimpleNamespace(journal_path=lambda snapshot:snapshot.with_suffix('.update.json'),
                HOST=SimpleNamespace(current_core=lambda *_:{'state':'running','health':'healthy','image':'fixture-current'},
                    controller_reference=lambda *_:'fixture-current',installation_fingerprint=lambda *_:{}))
            original_loader=L.load_sibling
            with mock.patch.object(L,'load_sibling',side_effect=lambda name,key:
                    update if name=='orbis-host-update.py' else RUNNER if name=='orbis-host-upgrade-runner.py'
                    else SimpleNamespace(Runtime=lambda:SimpleNamespace(unit=lambda _:{'MainPID':'0'}),
                        reconciliation_unit_name=S.reconciliation_unit_name) if name=='orbis-host-upgrade-supervision.py'
                    else original_loader(name,key)):
                yield root,job,admission,retained,journal

    def test_live_return_admission_derives_old_profile_from_ordered_source_bound_receipts(self):
        with self.owned_return() as (root,job,admission,retained,journal):
            with L.hold_owned_helper_job(self.state,job,root,'default',returning=retained) as owned:
                self.assertEqual(owned,{'job':(self.operation,'running'),'profile':None})
            with self.assertRaises(ValueError), L.hold_owned_helper_job(
                    self.state,job,root,'default',returning={**retained,'planSha256':'0'*64}):
                self.fail('Crossed plan admitted')

    def test_helper_return_refuses_changed_receipt_chain_before_yield(self):
        with self.owned_return() as (root,job,admission,retained,journal):
            path=journal.directory/journal.records[-1][0]
            value=L.decoded(path.read_bytes());value['previousSha256']='0'*64
            path.write_bytes(L.canonical(value))
            with self.assertRaises(ValueError), L.hold_owned_helper_job(self.state,job,root,'default',returning=retained):
                self.fail('Changed return chain admitted')

    def test_helper_return_still_requires_original_kernel_claim_and_selected_bytes(self):
        with self.owned_return() as (root,job,admission,retained,journal):
            self.scope.verify_bootstrap.side_effect=L.UpgradeSourceError()
            with self.assertRaises(ValueError), L.hold_owned_helper_job(self.state,job,root,'default',returning=retained):
                self.fail('Changed original process admitted')

    def child_scope(self,staged):
        directory=staged.directory.parent
        script=directory/'bootstrap/scripts/orbis-host-upgrade-launcher.py'
        script.parent.mkdir(mode=0o700,parents=True)
        script.write_bytes(b'# local lineage fixture\n')
        for name in ('orbis-release-plan.py', 'orbis-release-policy.py', 'migration-preflight.py'):
            (script.parent/name).write_bytes(self.files['scripts/'+name])
        job={'id':self.operation,'worker':{'requestSha256':'d'*64}}
        L.write_exclusive(self.state/'job.json',L.canonical(job))
        frame={'pid':5000,'invocationId':'c'*32,'unit':S.unit_name(self.operation)}
        L.write_exclusive(directory/'claim.json',L.canonical({'schema':'orbis.host-upgrade-claim.v1',
            'requestSha256':'d'*64,**frame}))
        L.write_exclusive(directory/'source-preparation.json',staged.descriptor)
        runtime=SimpleNamespace(process=mock.Mock(return_value={'parent':5000,'pid':5001,
            'argv':[os.fsencode(item) for item in L.source_child_argv(S,self.state,self.operation)],
            'cgroup':'/system.slice/'+S.unit_name(self.operation),'invocationId':'c'*32,
            'executable':str(S.PYTHON.resolve(strict=True))}))
        scope=SimpleNamespace(directory=directory,request_sha='d'*64,target=self.target,channel='stable',
            supervision=S,verify_bootstrap=mock.Mock(return_value=frame))
        return script,runtime,scope

    def test_source_child_requires_actual_parent_lineage_before_any_selected_code(self):
        staged=self.stage()
        script,runtime,scope=self.child_scope(staged)
        with mock.patch.object(L,'__file__',str(script)),mock.patch.object(L,'Bootstrap',return_value=scope), \
                mock.patch.object(L.os,'getpid',return_value=5001),mock.patch.object(L.os,'getppid',return_value=4999), \
                mock.patch.object(S,'Runtime',return_value=runtime),mock.patch.object(BOOT,'_exec_verified_installer') as execute:
            with self.assertRaises(L.UpgradeSourceError):L.check_source_child(self.state,self.operation)
            execute.assert_not_called()
        self.assertFalse((staged.directory/BOOT.SOURCE_EXECUTION).exists())

    def test_source_child_rechecks_full_selection_and_uses_only_source_check_arguments(self):
        self.build_inputs({**self.target, 'releaseChannel': 'stable', 'updatePriority': 'normal',
                           'criticalFixes': [], 'platforms': ['linux/amd64', 'linux/arm64']})
        staged=self.stage()
        script,runtime,scope=self.child_scope(staged)
        class Executed(BaseException):pass
        original=L.load_sibling
        with mock.patch.object(L,'__file__',str(script)),mock.patch.object(L,'Bootstrap',return_value=scope), \
                mock.patch.object(L.os,'getpid',return_value=5001),mock.patch.object(L.os,'getppid',return_value=5000), \
                mock.patch.object(S,'Runtime',return_value=runtime), \
                mock.patch.object(L,'load_sibling',side_effect=lambda name,key:BOOT if name=='install-orbis.py' else original(name,key)), \
                mock.patch.object(BOOT,'_exec_verified_installer',side_effect=Executed) as execute:
            with self.assertRaises(Executed):L.check_source_child(self.state,self.operation)
            args=execute.call_args.args
            self.assertEqual(args[0],staged.directory)
            self.assertEqual(args[2],['--verify-upgrade-source'])
            self.assertEqual(args[3],L.decoded(staged.descriptor)['selectionSha256'])
            self.assertEqual(args[4],BUILD.sources(self.files))

    def test_source_check_requires_real_custody_and_never_contacts_docker(self):
        with mock.patch.object(GUIDE.SENTINEL,'require_host'), \
                mock.patch.object(GUIDE.APPS,'Docker') as docker, \
                mock.patch.object(GUIDE,'prepare_sentinel') as sentinel, \
                mock.patch.object(GUIDE,'replacement') as replace:
            with self.assertRaises(ValueError):GUIDE.verify_upgrade_source(SimpleNamespace(channel='stable'),None)
            docker.assert_not_called();sentinel.assert_not_called();replace.assert_not_called()

    def test_source_check_cli_returns_before_installation_discovery_or_mutation(self):
        staged=self.stage()
        checked=self.execute(staged)
        selected=staged.directory
        argv=['guided','--manifest',str(selected/'release-manifest.json'),'--state-dir',str(selected/'transactions'),
              '--channel','stable','--installer-custody-sha256',checked['selectionSha256'],'--verify-upgrade-source']
        with mock.patch.object(GUIDE,'__file__',str(selected/'scripts/orbis-install.py')), \
                mock.patch.object(GUIDE.sys,'argv',argv),mock.patch.object(GUIDE,'load',return_value=SETUP), \
                mock.patch.object(GUIDE.BOOT,'require_supported_host'),mock.patch.object(GUIDE.SENTINEL,'require_host'), \
                mock.patch.object(GUIDE.APPS,'Docker') as docker, \
                mock.patch.object(GUIDE,'require_docker_prerequisites') as prerequisites, \
                mock.patch.object(GUIDE,'replacement') as replacement,contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(GUIDE.main(),0)
            self.assertEqual(json.loads(output.getvalue())['core'],self.target)
            docker.assert_not_called();prerequisites.assert_not_called();replacement.assert_not_called()

    def test_embedded_source_requirements_are_data_only_and_default_reader_stays_strict(self):
        template=self.files['scripts/install-orbis.py']
        self.assertEqual(BOOT.source_requirements(template,'orbis.installer-bundle.v5'),BOOT.REQUIRED_V5)
        for body in (b'REQUIRED=__import__("os").getuid()',b'REQUIRED={"../outside"}',
                     b'REQUIRED={"scripts/install-orbis.py"}\nREQUIRED={"scripts/orbis-install.py"}'):
            with self.subTest(body=body),self.assertRaises(ValueError):
                BOOT.source_requirements(body,'orbis.installer-bundle.v5')
        previous='6b627e1939e11e91fbd5c6ed419e1e90a71cf281'
        old=BUILD.committed_files(CORE,previous)
        core={**self.target,'tag':'v0.9.1','commit':previous}
        assets=BUILD.build(old,json.dumps(core).encode())
        identity={'tag':core['tag'],'commit':previous,'manifestSha256':BOOT.sha(assets[BOOT.MANIFEST])}
        with self.assertRaises(ValueError):BOOT.verify_manifest(assets[BOOT.MANIFEST],identity)
        manifest,files=BOOT.verify_source_package(assets[BOOT.MANIFEST],identity,assets[BOOT.ARCHIVE])
        self.assertEqual(files,BUILD.sources(old))
        self.assertEqual(manifest['commit'],previous)

    def test_changed_archived_source_git_blob_cannot_be_staged(self):
        self.tree['tree'][0]['sha']='0'*40
        with self.assertRaises(L.UpgradeSourceError):self.stage()
        self.assertFalse((S.operation_directory(self.state,self.operation)/'selection').exists())

    def test_symlink_mode_truncated_tree_and_wrong_commit_are_refused_before_extraction(self):
        original=copy.deepcopy(self.tree)
        for change in ('mode','truncated','sha'):
            self.tree=copy.deepcopy(original)
            if change=='mode':self.tree['tree'][0]['mode']='120000'
            elif change=='truncated':self.tree['truncated']=True
            else:self.tree['sha']='e'*40
            with self.subTest(change=change),self.assertRaises(L.UpgradeSourceError):self.stage()
        self.assertFalse((S.operation_directory(self.state,self.operation)/'selection').exists())

    def test_scope_changes_during_download_cannot_create_execution_or_selection(self):
        self.scope.verify_bootstrap.side_effect=[None,None,ValueError('scope changed')]
        with self.assertRaises(ValueError):self.stage()
        self.assertFalse((S.operation_directory(self.state,self.operation)/'selection').exists())

    def test_existing_selection_is_preserved_and_not_adopted(self):
        selected=S.operation_directory(self.state,self.operation)/'selection';selected.mkdir(mode=0o700)
        evidence=selected/'prior-evidence';evidence.write_bytes(b'prior')
        with self.assertRaises(L.UpgradeSourceError):self.stage()
        self.assertEqual(evidence.read_bytes(),b'prior')
        self.assertEqual(self.calls,[])

    def test_launcher_preamble_or_missing_fixed_executor_protocol_cannot_run(self):
        self.launcher+=b'\nraise RuntimeError("Unexpected launcher")\n'
        with self.assertRaises(L.UpgradeSourceError):self.stage()
        self.files=dict(self.base_files)
        self.files['scripts/orbis-install.py']=self.files['scripts/orbis-install.py'].replace(
            b"UPGRADE_SOURCE_CHECK_PROTOCOL = 'orbis.component-upgrade-source-check.v1'",b"UPGRADE_SOURCE_CHECK_PROTOCOL = 'unknown'")
        self.build_inputs()
        with self.assertRaises(L.UpgradeSourceError):self.stage()
        self.assertFalse((S.operation_directory(self.state,self.operation)/'selection').exists())

    def test_changed_staged_member_or_replaced_stage_object_cannot_reach_exec(self):
        staged=self.stage()
        member=staged.directory/'scripts/orbis-host-service.py';member.write_bytes(member.read_bytes()+b'\n')
        with mock.patch.object(BOOT,'_exec_verified_installer') as execute,self.assertRaises(L.UpgradeSourceError):
            L.execute_source(staged)
        execute.assert_not_called()

    def test_mutable_descriptor_and_fake_source_objects_are_not_execution_authority(self):
        staged=self.stage();staged.descriptor+=b' '
        with mock.patch.object(BOOT,'_exec_verified_installer') as execute,self.assertRaises(L.UpgradeSourceError):
            L.execute_source(staged)
        execute.assert_not_called()
        with self.assertRaises(L.UpgradeSourceError):L.execute_source(SimpleNamespace(used=False))

    def test_actual_continuation_is_the_only_producer_of_the_execution_receipt(self):
        staged=self.stage();value=L.decoded(staged.descriptor)
        launcher=staged.directory/BOOT.SOURCE_LAUNCHER
        identity=L.literal(launcher.read_bytes(),'EXPECTED_RELEASE')
        with launcher.open('rb') as held,mock.patch.object(BOOT,'OWNER',os.geteuid()), \
             mock.patch.object(BOOT,'__file__',f'/proc/self/fd/{held.fileno()}'), \
             mock.patch.object(BOOT,'EXPECTED_RELEASE',identity),mock.patch.object(BOOT,'_exec_guided') as guided:
            BOOT._continue_verified_installer([str(staged.directory),value['selectionSha256'],'stable',
                '--verify-upgrade-source'])
        proof=L.decoded((staged.directory/BOOT.SOURCE_EXECUTION).read_bytes())
        self.assertEqual(proof['selectionSha256'],value['selectionSha256'])
        self.assertEqual(proof['launcherSha256'],BOOT.sha(launcher.read_bytes()))
        guided.assert_called_once()
        self.assertEqual(guided.call_args.args[2],['--verify-upgrade-source'])

    def test_duplicate_ast_or_json_identity_fields_cannot_replace_source_selection(self):
        for body in (b'EXPECTED_RELEASE = {}\nEXPECTED_RELEASE = {}',b'EXPECTED_RELEASE = {"tag":1,"tag":2}'):
            with self.subTest(body=body),self.assertRaises(L.UpgradeSourceError):L.literal(body,'EXPECTED_RELEASE')
        with self.assertRaises(L.UpgradeSourceError):L.decoded(b'{"sha":1,"sha":2}')
        for body in (b'UPGRADE_SOURCE_CHECK_PROTOCOL=None', b'UPGRADE_SOURCE_CHECK_PROTOCOL="unknown"',
                     b'UPGRADE_SOURCE_CHECK_PROTOCOL="orbis.component-upgrade-source-check.v1"\nUPGRADE_SOURCE_CHECK_PROTOCOL=None'):
            with self.subTest(body=body),self.assertRaises(L.UpgradeSourceError):L.source_protocol(body,legacy=True)


if __name__=='__main__':unittest.main()
