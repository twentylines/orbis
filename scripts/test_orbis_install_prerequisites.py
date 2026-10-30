import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC=importlib.util.spec_from_file_location('prerequisites',Path(__file__).with_name('orbis-install-prerequisites.py'))
P=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(P)
SYSTEM={'distribution':'ubuntu','version':'24.04','codename':'noble','architecture':'arm64'}

class PolicyTests(unittest.TestCase):
    def test_exact_supported_distribution_userland_pairs(self):
        for distribution,version,code in P.SYSTEMS:
            for arch in ['arm64','amd64']:
                self.assertEqual(P.supported_system({'ID':distribution,'VERSION_ID':version,'VERSION_CODENAME':code},arch)['architecture'],arch)
        for value,arch in [({'ID':'raspbian','VERSION_ID':'12','VERSION_CODENAME':'bookworm'},'armhf'),({'ID':'ubuntu','VERSION_ID':'24.040','VERSION_CODENAME':'noble'},'arm64'),({'ID':'custom','ID_LIKE':'debian','VERSION_ID':'12','VERSION_CODENAME':'bookworm'},'arm64')]:
            with self.assertRaises(P.PrerequisiteError):P.supported_system(value,arch)
    def test_raspberry_pi_os64_uses_actual_debian_id_not_name_guessing(self):
        for version,code in [('12','bookworm'),('13','trixie')]:
            value={'NAME':'Raspberry Pi OS','PRETTY_NAME':'Raspberry Pi OS 64-bit','ID':'debian','VERSION_ID':version,'VERSION_CODENAME':code}
            self.assertEqual(P.supported_system(value,'arm64')['distribution'],'debian')
        with self.assertRaises(P.PrerequisiteError):P.supported_system({'NAME':'Raspberry Pi OS 64-bit','ID':'raspbian','VERSION_ID':'12','VERSION_CODENAME':'bookworm'},'armhf')
    def test_remote_context_or_environment_cannot_authorize_host_packages(self):
        for context,environment in [('remote',{}),('default',{'DOCKER_HOST':'tcp://remote:2375'}),('default',{'DOCKER_CONTEXT':'remote'})]:
            with self.subTest(context=context),mock.patch.dict(os.environ,environment,clear=True),self.assertRaises(P.PrerequisiteError):P.require_local_setup(context)
    def test_installed_but_unsupported_rsync_is_an_explicit_required_tool(self):
        with mock.patch.object(Path,'is_file',return_value=True),mock.patch.object(P,'run',return_value='rsync version 2.6.9 protocol version 29'):
            self.assertEqual(P.required_tools(),{'rsync'})
            self.assertIn('rsync',P.requested_packages({'kind':'ready'},SYSTEM,{'rsync':'2.6.9','iproute2':'1','ca-certificates':'1'}))

    def test_fixed_official_package_versions_are_native_to_each_reviewed_os(self):
        for distribution,version,code in P.SYSTEMS:
            fixed=P.versions({'distribution':distribution,'version':version,'codename':code})
            self.assertEqual(set(fixed),P.ENGINE_PACKAGES)
            self.assertTrue(all(value.endswith('~'+distribution+'.'+version+'~'+code) for value in fixed.values()))
    def test_changed_or_unexpected_signing_key_rejects(self):
        for value in [b'',b'-----BEGIN PGP PUBLIC KEY BLOCK-----\ninvalid',b'x'*65537]:
            with self.assertRaises(P.PrerequisiteError):P.key_fingerprint(value)
    def test_apt_first_config_is_required_and_global_environment_is_not_inherited(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'apt.conf').write_text('Dir::Etc::parts "-";');(root/'apt.conf').chmod(0o600)
            result=type('Result',(),{'returncode':0,'stdout':b'ok','stderr':b''})()
            with mock.patch.object(P.subprocess,'run',return_value=result) as execute,mock.patch.dict(os.environ,{'APT_CONFIG':'/unsafe/config'}):
                self.assertEqual(P.run([*P.apt_command(root),'update']),'ok')
                self.assertEqual(execute.call_args.kwargs['env']['APT_CONFIG'],str(root/'apt.conf'))
                self.assertEqual(execute.call_args.kwargs['env']['NEEDRESTART_MODE'],'l')
                with self.assertRaises(P.PrerequisiteError):P.run(['/usr/bin/apt-get','update'])
    def test_isolated_apt_has_only_fixed_bounded_sources_cache_and_signature_checks(self):
        command=P.apt_command(Path('/protected/cache'))
        self.assertEqual(command[0],'/usr/bin/apt-get')
        self.assertIn('APT::Get::AllowUnauthenticated=false',command)
        self.assertIn('Acquire::AllowInsecureRepositories=false',command)
        self.assertIn('Dir::State::lists=/protected/cache/lists',command)
        self.assertNotIn('upgrade',command)
        self.assertNotIn('--allow-unauthenticated',command)
    def test_simulation_accepts_only_reviewed_new_packages_and_exact_versions(self):
        review=P.parse_simulation('Inst docker-ce (5:29.9.2 Docker:stable [arm64])\nConf docker-ce (5:29.9.2 Docker:stable [arm64])',{}, {'docker-ce':'5:29.9.2'})
        self.assertEqual(review['selected']['docker-ce'],{'old':None,'version':'5:29.9.2'})
    def test_solver_selected_library_upgrade_is_recorded_with_exact_previous_version(self):
        review=P.parse_simulation('Inst docker-ce (5:29.9.2 Docker:stable [arm64])\nInst libseccomp2 [2.5.0] (2.6.0 Ubuntu:noble [arm64])',{'libseccomp2':'2.5.0'},{'docker-ce':'5:29.9.2'})
        self.assertEqual(review['selected']['libseccomp2'],{'old':'2.5.0','version':'2.6.0'})
    def test_unrelated_upgrade_removal_purge_version_injection_or_reconfiguration_reject(self):
        examples=['Inst unrelated [1] (2 Ubuntu:noble [arm64])','Remv ssh [1]','Purg docker.io [1]','Inst docker-ce (version;bad Docker:stable [arm64])','Conf unrelated (1 Ubuntu:noble [arm64])','Inst docker-ce [1] (2 Docker:stable [arm64])']
        for text in examples:
            with self.subTest(text=text),self.assertRaises(P.PrerequisiteError):P.parse_simulation(text,{}, {'docker-ce':'2'},True)
    def test_known_nonpurge_conflict_removal_needs_explicit_review_and_exact_baseline(self):
        text='Remv docker.io [20.10]\nInst docker-ce (5:29.9.2 Docker:stable [arm64])'
        self.assertEqual(P.parse_simulation(text,{'docker.io':'20.10'},{'docker-ce':'5:29.9.2'},True)['removed'],{'docker.io':'20.10'})
        with self.assertRaises(P.PrerequisiteError):P.parse_simulation(text,{'docker.io':'20.10'},{'docker-ce':'5:29.9.2'},False)
    def test_final_protocol_rejects_changed_package_state_or_action(self):
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'docker.deb';archive.write_bytes(b'archive');archive.chmod(0o600)
            item={'path':str(archive),'sha256':hashlib.sha256(b'archive').hexdigest(),'old':None,'version':'1'}
            plan={'packages':{'docker-ce':item},'removed':{}}
            good='VERSION 2\n\ndocker-ce - < 1 '+str(archive)+'\ndocker-ce - < 1 **CONFIGURE**\n'
            self.assertTrue(P.verify_protocol(plan,good))
            for changed in [good.replace(' - < ',' 0 < '),good.replace('docker-ce','unrelated'),good+'docker-ce - < 1 **REMOVE**\n',good.replace('VERSION 2','VERSION 1')]:
                with self.assertRaises(P.PrerequisiteError):P.verify_protocol(plan,changed)
            archive.write_bytes(b'changed')
            with self.assertRaises(P.PrerequisiteError):P.verify_protocol(plan,good)
    def test_restart_policy_roundtrip_preserves_retry_count(self):
        self.assertEqual(P.restart_argument({'Name':'on-failure','MaximumRetryCount':5}),'on-failure:5')
        self.assertEqual(P.restart_argument({'Name':'unless-stopped','MaximumRetryCount':0}),'unless-stopped')
    def test_missing_docker_is_reported_as_required_setup_without_command(self):
        with mock.patch.object(P,'host'),mock.patch.object(P.shutil,'which',return_value=None),mock.patch.object(P,'run') as run:
            self.assertEqual(P.inspect()['kind'],'install');run.assert_not_called()
    def test_stopped_local_daemon_has_safe_start_path_instead_of_generic_failure(self):
        def execute(args,**_kwargs):
            return 'loaded' if 'show' in args else 'inactive'
        with mock.patch.object(P,'host'),mock.patch.object(P.shutil,'which',return_value='/usr/bin/docker'),mock.patch.object(P,'docker',side_effect=['"unix:///run/docker.sock"',P.PrerequisiteError('daemon stopped')]),mock.patch.object(P,'run',side_effect=execute):
            self.assertEqual(P.inspect()['kind'],'start')
    def test_custom_default_socket_never_falls_back_to_starting_host_docker(self):
        for endpoint in ['unix:///tmp/other.sock','tcp://other:2376','ssh://other','unix:///run/user/1000/docker.sock']:
            with self.subTest(endpoint=endpoint),mock.patch.object(P,'host'),mock.patch.object(P.shutil,'which',return_value='/usr/bin/docker'),mock.patch.object(P,'docker',return_value=json.dumps(endpoint)),mock.patch.object(P,'run') as execute,self.assertRaisesRegex(P.PrerequisiteError,'custom or remote'):
                P.inspect()
            execute.assert_not_called()
    def test_cli_without_daemon_or_previous_data_is_a_fresh_install(self):
        with mock.patch.object(P,'host'),mock.patch.object(P.shutil,'which',return_value='/usr/bin/docker'),mock.patch.object(P,'docker',side_effect=['"unix:///run/docker.sock"',P.PrerequisiteError('not installed')]),mock.patch.object(P,'run',return_value='not-found'),mock.patch.object(Path,'exists',return_value=False):
            self.assertEqual(P.inspect()['kind'],'install')


class FreshFlowTests(unittest.TestCase):
    def test_compatible_engine_and_tools_never_open_apt_or_private_transaction(self):
        with mock.patch.object(P,'host'),mock.patch.object(P,'inspect',return_value={'kind':'ready'}),mock.patch.object(P,'tools_required',return_value=False),mock.patch.object(P,'prepare_repository') as repository,mock.patch.object(P,'private_directory') as directory:
            self.assertEqual(P.prepare('default',Path('/unused'))['changed'],False)
            repository.assert_not_called();directory.assert_not_called()
    def test_declining_required_setup_changes_no_package_service_or_directory(self):
        with mock.patch.object(P,'host'),mock.patch.object(P,'inspect',return_value={'kind':'install'}),mock.patch.object(P,'require_local_setup'),mock.patch.object(P.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04','VERSION_CODENAME':'noble'}),mock.patch.object(P,'run',return_value='arm64'),mock.patch.object(P,'private_directory') as directory,mock.patch.object(P,'prepare_repository') as repository:
            with self.assertRaisesRegex(P.PrerequisiteError,'cancelled'):P.prepare('default',Path('/unused'),ask=lambda _:'n')
            directory.assert_not_called();repository.assert_not_called()
    def test_inspection_only_cannot_install_missing_prerequisites(self):
        with mock.patch.object(P,'host'),mock.patch.object(P,'inspect',return_value={'kind':'install'}),mock.patch.object(P,'require_local_setup') as local:
            with self.assertRaisesRegex(P.PrerequisiteError,'Inspection'):P.prepare('default',Path('/unused'),inspect_only=True)
            local.assert_not_called()
    def test_uninspectable_existing_engine_data_is_never_treated_as_fresh(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);actual_exists=Path.exists
            def exists(path):return True if str(path)=='/var/lib/docker' else actual_exists(path)
            def private(path):path=Path(path);path.mkdir(parents=True,exist_ok=True);return path
            with mock.patch.object(P,'host'),mock.patch.object(P,'inspect',return_value={'kind':'install'}),mock.patch.object(P,'require_local_setup'),mock.patch.object(P,'host_barrier',return_value=contextlib.nullcontext()),mock.patch.object(P.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04','VERSION_CODENAME':'noble'}),mock.patch.object(P,'run',return_value='arm64'),mock.patch.object(P,'private_directory',side_effect=private),mock.patch.object(Path,'exists',exists),mock.patch.object(P,'install_required') as install,contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(P.PrerequisiteError,'Docker data already exists'):
                P.prepare('default',root,accepted=True)
            install.assert_not_called()

    def fresh(self,failed=False):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);cache=root/'public-cache'
            def private(path):path=Path(path);path.mkdir(parents=True,exist_ok=True);return path
            def public(_path):cache.mkdir(exist_ok=True);return cache
            installed={};review={'selected':{'docker-ce':{'old':None,'version':'1'}},'removed':{}}
            actual_exists=Path.exists
            def exists(path):return False if str(path) in {'/var/lib/docker','/var/lib/containerd'} else actual_exists(path)
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(Path,'exists',exists))
                for name,value in [('host',None),('require_local_setup',None),('tools_required',False),('installed_packages',installed),('service_helpers',{}),('prepare_repository',None),('requested_packages',{'docker-ce':'1'}),('simulate',review),('acquire_archives',{'docker-ce':{'version':'1'}}),('backup_packages',{}),('persist_repository',None)]:stack.enter_context(mock.patch.object(P,name,return_value=value))
                stack.enter_context(mock.patch.object(P,'inspect',side_effect=[{'kind':'install','context':'default'},{'kind':'ready'}]))
                stack.enter_context(mock.patch.object(P,'private_directory',side_effect=private));stack.enter_context(mock.patch.object(P,'public_directory',side_effect=public))
                stack.enter_context(mock.patch.object(P.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04','VERSION_CODENAME':'noble'}))
                execute=stack.enter_context(mock.patch.object(P,'run',side_effect=lambda args,**_:'arm64' if '--print-architecture' in args else ''))
                apply=stack.enter_context(mock.patch.object(P,'apply_packages',side_effect=RuntimeError('controlled package failure') if failed else None))
                stages=[]
                with contextlib.redirect_stdout(io.StringIO()):
                    if failed:
                        with self.assertRaisesRegex(P.PrerequisiteError,'private recovery journal'):P.prepare('default',root,accepted=True,progress=stages.append)
                    else:self.assertTrue(P.prepare('default',root,accepted=True,progress=stages.append)['changed'])
                pointer=json.loads((root/'docker-setup/current.json').read_text());journal=json.loads((root/'docker-setup'/pointer['id']/'journal.json').read_text())
                self.assertEqual(journal['phase'],'recovery-required' if failed else 'complete')
                self.assertEqual(apply.call_count,1)
                calls=[call.args[0] for call in execute.call_args_list]
                self.assertEqual(any('enable' in args and 'docker.service' in args for args in calls),not failed)
                self.assertFalse(any('remove' in args or 'purge' in args or 'upgrade' in args for args in calls))
                self.assertIn('Installing required packages',stages)
    def test_fresh_vertical_slice_reviews_then_applies_then_confirms_services(self):self.fresh()
    def test_failed_package_application_retains_journal_and_never_starts_daemon(self):self.fresh(True)


class RecoveryTests(unittest.TestCase):
    def test_recovery_downgrade_protocol_is_exact_and_cannot_masquerade_as_upgrade(self):
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'old.deb';archive.write_bytes(b'old');archive.chmod(0o600)
            item={'path':str(archive),'sha256':P.sha(archive),'old':'2','version':'1','direction':'>'}
            plan={'packages':{'docker.io':item},'removed':{'docker-ce':'2'}}
            good='VERSION 2\n\ndocker-ce 2 > - **REMOVE**\ndocker.io 2 > 1 '+str(archive)+'\ndocker.io 2 > 1 **CONFIGURE**\n'
            self.assertTrue(P.verify_protocol(plan,good))
            with self.assertRaises(P.PrerequisiteError):P.verify_protocol(plan,good.replace('2 > 1','2 < 1'))
    def test_legacy_rollback_packages_are_only_allowed_in_explicit_recovery(self):
        text='Inst docker.io (20.10 Ubuntu:noble [arm64])'
        with self.assertRaises(P.PrerequisiteError):P.parse_simulation(text,{}, {'docker.io':'20.10'},True)
        self.assertIn('docker.io',P.parse_simulation(text,{}, {'docker.io':'20.10'},True,recovery=True)['selected'])
    def test_recovery_may_remove_only_exact_transaction_introduced_dependencies(self):
        text='Remv libseccomp2 [2.6]\nInst docker.io (20.10 Ubuntu:noble [arm64])'
        for recovery,allowed in [(False,{'libseccomp2':'2.6'}),(True,{}),(True,{'libseccomp2':'2.5'})]:
            with self.subTest(recovery=recovery,allowed=allowed),self.assertRaises(P.PrerequisiteError):
                P.parse_simulation(text,{'libseccomp2':'2.6'},{'docker.io':'20.10'},True,recovery=recovery,permitted_removals=allowed)
        review=P.parse_simulation(text,{'libseccomp2':'2.6'},{'docker.io':'20.10'},True,recovery=True,permitted_removals={'libseccomp2':'2.6'})
        self.assertEqual(review['removed'],{'libseccomp2':'2.6'})

    def test_recovery_never_overwrites_app_writes_after_durable_resume_barrier(self):
        with mock.patch.object(P,'run') as execute:
            for phase in ['apps-resumed','recovery-required','complete']:
                with self.subTest(phase=phase),self.assertRaisesRegex(P.PrerequisiteError,'Apps have resumed'):
                    P.rollback_engine(Path('/unused'),{'phase':phase,'appsResumed':True},lambda _:None)
            execute.assert_not_called()
    def test_stable_inventory_checks_original_id_image_mount_network_and_running_state(self):
        original={'root':'/var/lib/docker','driver':'overlay2','images':['sha256:image'],'networks':[{'id':'a'*64,'name':'custom','driver':'bridge','internal':True,'ipam':{'Driver':'default','Options':{},'Config':[{'Subnet':'172.18.0.0/16','Gateway':'172.18.0.1'}]}}],'volumes':[{'name':'data'}],'containers':[{'id':'container','imageId':'sha256:image','image':'example:old','mounts':[{'Name':'data'}],'networks':{'default':{'NetworkID':'network'}},'running':True,'restart':{'Name':'on-failure','MaximumRetryCount':3}}]}
        self.assertTrue(P.same_inventory(original,copy.deepcopy(original),restored=True))
        for key,value in [('id','replacement'),('imageId','sha256:new'),('mounts',[]),('networks',{}),('running',False),('restart',{'Name':'always'})]:
            changed=copy.deepcopy(original);changed['containers'][0][key]=value
            self.assertFalse(P.same_inventory(original,changed,restored=True))
    def test_quiesce_disables_restart_before_stop_and_stops_daemon_last(self):
        before={'containers':[{'id':'a','running':True,'restart':{'Name':'always'}},{'id':'b','running':False,'restart':{'Name':'no'}}]}
        after={'containers':[dict(item,running=False) for item in before['containers']]};calls=[]
        with mock.patch.object(P,'same_inventory',return_value=True),mock.patch.object(P,'inventory',side_effect=[before,after]),mock.patch.object(P,'docker',side_effect=lambda context,args,**_:calls.append(args)),mock.patch.object(P,'run',side_effect=lambda args,**_:calls.append(args)):
            P.quiesce('default',before)
        self.assertEqual(calls[:2],[['container','update','--restart=no','a'],['container','update','--restart=no','b']])
        self.assertEqual(calls[2],['container','stop','--time','60','a'])
        self.assertEqual(calls[-1],['/usr/bin/systemctl','stop','docker.socket','docker.service','containerd.service'])
    def test_resume_restores_only_original_running_set_and_exact_retry_policy(self):
        old={'containers':[{'id':'a','running':True,'restart':{'Name':'on-failure','MaximumRetryCount':4}},{'id':'b','running':False,'restart':{'Name':'unless-stopped','MaximumRetryCount':0}}]}
        stopped=copy.deepcopy(old);stopped['containers'][0]['running']=False
        with mock.patch.object(P,'inventory',side_effect=[stopped,old]),mock.patch.object(P,'same_inventory',return_value=True),mock.patch.object(P,'docker') as execute:
            P.restore_workloads('default',old)
        self.assertEqual([call.args[1] for call in execute.call_args_list],[['container','update','--restart=on-failure:4','a'],['container','update','--restart=unless-stopped','b'],['container','start','a']])
    def test_changed_volume_data_seal_stops_recovery_before_any_copy(self):
        directory=Path('/private-transaction');record={'source':'/var/lib/docker','backup':str(directory/'storage/0'),'seal':{'sha256':'sealed'},'volumeDataSeal':{'sha256':'original'}}
        with mock.patch.object(P,'require_no_nested_mounts'),mock.patch.object(P,'read',return_value=[record]),mock.patch.object(P,'storage_seal',side_effect=[record['seal'],{'sha256':'new app writes'}]),mock.patch.object(P,'run') as execute,self.assertRaisesRegex(P.PrerequisiteError,'App volume data changed'):
            P.restore_storage(directory)
        execute.assert_not_called()
    def test_storage_seal_detects_content_change_even_with_same_length_and_time(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'data';path.write_bytes(b'abc');stamp=path.stat().st_mtime_ns
            before=P.storage_seal(Path(folder));path.write_bytes(b'xyz');os.utime(path,ns=(stamp,stamp))
            self.assertNotEqual(before,P.storage_seal(Path(folder)))
    def test_nested_host_mount_is_rejected_before_copy_or_restore(self):
        raw='1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /var/lib/docker/volumes/data/_data rw - nfs server:/data rw\n'
        with mock.patch.object(Path,'read_text',return_value=raw),self.assertRaisesRegex(P.PrerequisiteError,'nested mounted filesystem'):
            P.require_no_nested_mounts([{'source':'/var/lib/docker'}])
        with mock.patch.object(Path,'read_text',return_value=raw.splitlines()[0]+'\n'):
            P.require_no_nested_mounts([{'source':'/var/lib/docker'}])

    def test_source_mismatch_does_not_run_recovery_or_change_original_journal(self):
        with mock.patch.object(P,'sha',return_value='current'),mock.patch.object(P,'run') as execute,mock.patch.object(P,'save') as save,self.assertRaisesRegex(P.PrerequisiteError,'exact retained installer'):
            P.resume_transaction(Path('/unused'),{'sourceSha256':'different','context':'default'},lambda _:None)
        execute.assert_not_called();save.assert_not_called()
    def test_backed_up_engine_recovery_is_used_before_starting_new_transaction(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);directory=root/'job';directory.mkdir();(directory/'storage.json').write_text('[]')
            journal={'sourceSha256':P.sha(P.__file__),'context':'default','hadEngine':True,'inventory':{'containers':[]},'phase':'recovery-required'}
            with mock.patch.object(P,'rollback_engine') as rollback,mock.patch.object(P,'save'),mock.patch.object(P,'apply_packages') as apply:
                result=P.resume_transaction(directory,journal,lambda _:None)
            self.assertEqual(result['result'],'recovered');rollback.assert_called_once();apply.assert_not_called()
    def test_resumed_apps_recovery_confirms_running_set_without_restoring_storage(self):
        with tempfile.TemporaryDirectory() as folder:
            journal={'sourceSha256':P.sha(P.__file__),'context':'default','hadEngine':True,'inventory':{'containers':[]},'appsResumed':True,'phase':'recovery-required'}
            with mock.patch.object(P,'run'),mock.patch.object(P,'restore_workloads') as workloads,mock.patch.object(P,'inspect',return_value={'kind':'ready'}),mock.patch.object(P,'rollback_engine') as rollback,mock.patch.object(P,'restore_storage') as storage:
                result=P.resume_transaction(Path(folder),journal,lambda _:None)
            self.assertTrue(result['changed']);workloads.assert_called_once();rollback.assert_not_called();storage.assert_not_called()
    def test_old_pending_journal_is_checked_even_when_engine_is_now_compatible(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'docker-setup').mkdir()
            with mock.patch.object(P,'host'),mock.patch.object(P,'pending_transaction',return_value=(root,{'phase':'recovery-required','action':{'kind':'install'}})),mock.patch.object(P,'inspect',return_value={'kind':'ready'}),mock.patch.object(P,'tools_required',return_value=False),self.assertRaisesRegex(P.PrerequisiteError,'Inspection'):
                P.prepare('default',root,inspect_only=True)
    def test_foreign_containerd_workloads_block_before_package_or_container_changes(self):
        with mock.patch.object(P.shutil,'which',return_value='/usr/bin/ctr'),mock.patch.object(P,'run',return_value='moby\nk8s.io') as execute,self.assertRaisesRegex(P.PrerequisiteError,'Other workloads share'):
            P.require_exclusive_engine({'containerd.io':'1'})
        self.assertEqual(execute.call_count,1)

class NetworkCompatibilityTests(unittest.TestCase):
    def snapshot(self):
        networks=[{'id':'a'*64,'name':'bridge','driver':'bridge','internal':False,'ipam':{'Driver':'default','Options':None,'Config':[{'Subnet':'172.17.0.0/16','Gateway':'172.17.0.1'}]}},{'id':'b'*64,'name':'host','driver':'host','internal':False,'ipam':{'Driver':'default','Options':None,'Config':[]}},{'id':'c'*64,'name':'none','driver':'null','internal':False,'ipam':{'Driver':'default','Options':None,'Config':[]}},{'id':'d'*64,'name':'custom','driver':'bridge','internal':True,'ipam':{'Driver':'default','Options':{},'Config':[{'Subnet':'172.18.0.0/16','Gateway':'172.18.0.1'}]}}]
        return {'root':'/var/lib/docker','driver':'overlay2','images':['sha256:'+'1'*64],'volumes':[],'networks':networks,'containers':[{'id':'2'*64,'imageId':'sha256:'+'1'*64,'image':'owned:1','mounts':[],'networks':{'bridge':{'NetworkID':'a'*64,'Aliases':None,'IPAMConfig':None},'custom':{'NetworkID':'d'*64,'Aliases':['owned'],'IPAMConfig':None}},'running':False,'restart':{'Name':'no','MaximumRetryCount':0}}]}
    def test_validated_builtin_regeneration_and_empty_ipam_representation_are_equivalent(self):
        before=self.snapshot();after=copy.deepcopy(before)
        after['networks'][0]['id']='e'*64;after['networks'][1]['ipam']['Config']=None;after['networks'][2]['ipam']['Config']=None
        after['networks'].reverse();after['containers'][0]['networks']['bridge']['NetworkID']='e'*64
        self.assertTrue(P.same_inventory(before,after,restored=True))
    def test_custom_network_identity_or_configuration_changes_remain_rejected(self):
        for change in [('id','e'*64),('internal',False),('ipam',{'Driver':'default','Options':{},'Config':None})]:
            before=self.snapshot();after=copy.deepcopy(before);after['networks'][3][change[0]]=change[1]
            with self.subTest(change=change):self.assertFalse(P.same_inventory(before,after))
    def test_builtin_name_alone_cannot_waive_driver_scope_or_address_changes(self):
        for index,key,value in [(0,'driver','macvlan'),(0,'internal',True),(0,'ipam',{'Driver':'default','Options':None,'Config':[{'Subnet':'172.19.0.0/16','Gateway':'172.19.0.1'}]}),(1,'ipam',{'Driver':'default','Options':None,'Config':[{'Subnet':'172.17.0.0/16'}]})]:
            before=self.snapshot();after=copy.deepcopy(before);after['networks'][index][key]=value
            with self.subTest(key=key,value=value):self.assertFalse(P.same_inventory(before,after))
    def test_builtin_reference_must_match_that_snapshot_validated_network(self):
        before=self.snapshot();after=copy.deepcopy(before);after['containers'][0]['networks']['bridge']['NetworkID']='f'*64
        self.assertFalse(P.same_inventory(before,after))
        after=copy.deepcopy(before);after['networks'].append(copy.deepcopy(after['networks'][0]))
        self.assertFalse(P.same_inventory(before,after))

class ArchiveStagingTests(unittest.TestCase):
    def test_retained_epoch_archive_is_hash_staged_into_isolated_no_download_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);retained=root/'rollback';cache=root/'archives';retained.mkdir();cache.mkdir()
            source=retained/'docker-ce_5%3a24.0.9_arm64.deb';source.write_bytes(b'retained archive');source.chmod(0o600)
            item={'path':str(source),'sha256':P.sha(source),'version':'5:24.0.9','old':'5:29.9.2'}
            previous_umask=os.umask(0o077)
            try:
                with mock.patch.object(P,'public_directory',return_value=cache):staged=P.stage_archives(root,{'docker-ce':item})
            finally:os.umask(previous_umask)
            target=cache/source.name
            self.assertEqual(target.stat().st_mode&0o777,0o644)
            self.assertEqual(staged['docker-ce']['path'],str(target));self.assertEqual(staged['docker-ce']['retainedPath'],str(source))
            self.assertEqual(P.sha(target),item['sha256']);self.assertTrue(source.exists())
            job=root/'job';job.mkdir();P.save(job/'plan.json',{'aptDirectory':str(root),'packages':staged,'removed':{},'recovery':True})
            command=P.package_apply_command(job,job/'plan.json')
            self.assertIn('--no-download',command);self.assertIn(str(target),command);self.assertNotIn(str(source),command)
    def test_changed_cache_archive_or_symlink_is_never_overwritten(self):
        for symbolic in [False,True]:
            with self.subTest(symbolic=symbolic),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/'old.deb';source.write_bytes(b'retained');cache=root/'archives';cache.mkdir();other=root/'outside';other.write_bytes(b'preserve')
                target=cache/source.name
                if symbolic:target.symlink_to(other)
                else:target.write_bytes(b'preserve')
                with mock.patch.object(P,'public_directory',return_value=cache),self.assertRaises(P.PrerequisiteError):P.stage_archives(root,{'docker-ce':{'path':str(source),'sha256':P.sha(source)}})
                self.assertEqual(other.read_bytes(),b'preserve');self.assertEqual(target.read_bytes(),b'preserve')
    def test_changed_retained_archive_is_rejected_before_creating_cache_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'old.deb';source.write_bytes(b'changed');cache=root/'archives';cache.mkdir()
            with mock.patch.object(P,'public_directory',return_value=cache),self.assertRaises(P.PrerequisiteError):P.stage_archives(root,{'docker-ce':{'path':str(source),'sha256':hashlib.sha256(b'original').hexdigest()}})
            self.assertEqual(list(cache.iterdir()),[])

class RollbackSafetyTests(unittest.TestCase):
    def test_external_baseline_package_change_refuses_before_service_or_package_mutation(self):
        journal={'context':'default','aptDirectory':'/cache','phase':'installing-required-packages','rollbackPackages':{'docker-ce':{'version':'1'}},'review':{'selected':{'docker-ce':{'old':'1','version':'2'}},'removed':{}}}
        with mock.patch.object(P,'installed_packages',return_value={'docker-ce':'3'}),mock.patch.object(P,'run') as execute,mock.patch.object(P,'restore_storage') as storage,self.assertRaisesRegex(P.PrerequisiteError,'changed outside'):
            P.rollback_engine(Path('/unused'),journal,lambda _:None)
        execute.assert_not_called();storage.assert_not_called()
    def test_only_old_or_reviewed_target_baseline_version_can_pass_rollback_preflight(self):
        for current in ['1','2']:
            journal={'context':'default','aptDirectory':'/cache','phase':'installing-required-packages','rollbackPackages':{'docker-ce':{'version':'1'}},'review':{'selected':{'docker-ce':{'old':'1','version':'2'}},'removed':{}}}
            with self.subTest(current=current),mock.patch.object(P,'installed_packages',return_value={'docker-ce':current}),mock.patch.object(P,'run',side_effect=RuntimeError('stop seam')) as execute,self.assertRaisesRegex(RuntimeError,'stop seam'):
                P.rollback_engine(Path('/unused'),journal,lambda _:None)
            self.assertEqual(execute.call_args.args[0],['/usr/bin/systemctl','stop','docker.socket','docker.service','containerd.service'])
    def test_unplanned_baseline_disappearance_also_refuses_before_services_stop(self):
        journal={'context':'default','aptDirectory':'/cache','phase':'installing-required-packages','rollbackPackages':{'docker-ce':{'version':'1'}},'review':{'selected':{'docker-ce':{'old':'1','version':'2'}},'removed':{}}}
        with mock.patch.object(P,'installed_packages',return_value={}),mock.patch.object(P,'run') as execute,self.assertRaisesRegex(P.PrerequisiteError,'changed outside'):
            P.rollback_engine(Path('/unused'),journal,lambda _:None)
        execute.assert_not_called()
    def test_interruption_during_rollback_resume_never_restores_writable_layer_again(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);archive=root/'original.deb';archive.write_bytes(b'retained old package');archive.chmod(0o600)
            journal={'schema':'orbis.docker-setup.v1','sourceSha256':P.sha(P.__file__),'context':'default','aptDirectory':str(root/'cache'),'phase':'recovery-required','hadEngine':True,'inventory':{'containers':[{'id':'original-running'}]},'rollbackPackages':{'docker-ce':{'name':'docker-ce','version':'1','path':str(archive),'sha256':P.sha(archive)}},'review':{'selected':{'docker-ce':{'old':'1','version':'2'}},'removed':{}}}
            layer={'content':'checkpoint'};resume_calls=[]
            def private(path):path=Path(path);path.mkdir(mode=0o700);return path
            def command(args,**_):
                if '--simulate' in args:return 'Inst docker-ce [2] (1 Docker:stable [arm64])\nConf docker-ce (1 Docker:stable [arm64])'
                if 'daemon-reload' in args or 'start' in args:
                    saved=json.loads((root/'journal.json').read_text())
                    self.assertTrue(saved['appsResumed']);self.assertEqual(saved['resumeOutcome'],'rolled-back')
                return ''
            def resume(*_):
                resume_calls.append(True)
                if len(resume_calls)==1:
                    layer['content']='accepted write in container writable layer'
                    raise InterruptedError('crash after first original app resumes')
                self.assertEqual(layer['content'],'accepted write in container writable layer')
            with mock.patch.object(P,'installed_packages',side_effect=[{'docker-ce':'2'},{'docker-ce':'1'},{'docker-ce':'1'}]),mock.patch.object(P,'run',side_effect=command),mock.patch.object(P,'private_directory',side_effect=private),mock.patch.object(P,'package_direction',return_value='>'),mock.patch.object(P,'apply_packages') as apply,mock.patch.object(P,'restore_storage') as restore,mock.patch.object(P,'restore_workloads',side_effect=resume),mock.patch.object(P,'inspect',return_value={'kind':'upgrade'}):
                with self.assertRaisesRegex(InterruptedError,'first original app'):P.rollback_engine(root,journal,lambda _:None)
                persisted=json.loads((root/'journal.json').read_text());persisted['phase']='recovery-required';P.save(root/'journal.json',persisted)
                self.assertTrue(persisted['appsResumed'])
                result=P.resume_transaction(root,persisted,lambda _:None)
            self.assertEqual(restore.call_count,1);self.assertEqual(apply.call_count,1)
            self.assertEqual(result['outcome'],'rolled-back');self.assertEqual(result['result'],'previous-docker-recovered')
            self.assertEqual(json.loads((root/'journal.json').read_text())['phase'],'rolled-back')
            self.assertEqual(layer['content'],'accepted write in container writable layer')
    def test_finished_rollback_is_returned_without_immediately_retrying_failed_upgrade(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);setup=root/'docker-setup';setup.mkdir(mode=0o700)
            unfinished=(setup,{'action':{'kind':'upgrade','context':'default'}})
            def private(path):path=Path(path);path.mkdir(parents=True,exist_ok=True);return path
            with mock.patch.object(P,'host'),mock.patch.object(P,'pending_transaction',return_value=unfinished),mock.patch.object(P,'inspect') as inspect,mock.patch.object(P,'require_local_setup'),mock.patch.object(P.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04','VERSION_CODENAME':'noble'}),mock.patch.object(P,'run',return_value='arm64'),mock.patch.object(P,'private_directory',side_effect=private),mock.patch.object(P,'host_barrier',return_value=contextlib.nullcontext()),mock.patch.object(P,'resume_transaction',return_value={'result':'previous-docker-recovered','changed':True,'outcome':'rolled-back'}),mock.patch.object(P,'upgrade_existing') as upgrade,contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(P.prepare('default',root,accepted=True)['outcome'],'rolled-back')
            upgrade.assert_not_called();inspect.assert_not_called()

    def test_rolled_back_resume_detects_package_drift_before_starting_any_service(self):
        with tempfile.TemporaryDirectory() as folder:
            journal={'sourceSha256':P.sha(P.__file__),'context':'default','hadEngine':True,'inventory':{'containers':[]},'appsResumed':True,'resumeOutcome':'rolled-back','rollbackPackages':{'docker-ce':{'version':'1'}},'phase':'recovery-required'}
            with mock.patch.object(P,'installed_packages',return_value={'docker-ce':'3'}),mock.patch.object(P,'run') as execute,mock.patch.object(P,'restore_storage') as storage,self.assertRaisesRegex(P.PrerequisiteError,'package versions changed'):
                P.resume_transaction(Path(folder),journal,lambda _:None)
            execute.assert_not_called();storage.assert_not_called()

class UpgradePrerequisiteTests(unittest.TestCase):
    def test_missing_recovery_tool_stops_direct_downtime_path_before_any_inventory(self):
        with mock.patch.object(P,'tools_required',return_value=True),mock.patch.object(P,'inventory') as inventory,mock.patch.object(P,'installed_packages') as packages,self.assertRaisesRegex(P.PrerequisiteError,'recovery tools'):
            P.upgrade_existing('default',Path('/unused'),SYSTEM,{'kind':'upgrade'},lambda _:None)
        inventory.assert_not_called();packages.assert_not_called()
    def test_prepare_completes_separate_required_tools_transaction_before_engine_update(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);calls=[]
            def private(path):path=Path(path);path.mkdir(parents=True,exist_ok=True);return path
            with mock.patch.object(P,'host'),mock.patch.object(P,'inspect',return_value={'kind':'upgrade','context':'default'}),mock.patch.object(P,'tools_required',return_value=True),mock.patch.object(P,'require_local_setup'),mock.patch.object(P,'host_barrier',return_value=contextlib.nullcontext()),mock.patch.object(P,'private_directory',side_effect=private),mock.patch.object(P.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04','VERSION_CODENAME':'noble'}),mock.patch.object(P,'run',return_value='arm64'),mock.patch.object(P,'install_required',side_effect=lambda *args:calls.append(('tools',args[3]))),mock.patch.object(P,'upgrade_existing',side_effect=lambda *args:calls.append(('engine',args[3])) or {'changed':True}),contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(P.prepare('default',root,accepted=True)['changed'])
            self.assertEqual([item[0] for item in calls],['tools','engine'])
            self.assertEqual(calls[0][1]['kind'],'tools')

class UpgradeFlowTests(unittest.TestCase):
    def exercise(self,failure=None):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);cache=root/'cache';calls=[]
            snapshot={'root':'/var/lib/docker','driver':'overlay2','containers':[],'volumes':[],'networks':[],'images':[]}
            review={'selected':{'docker-ce':{'old':'1','version':'2'}},'removed':{}}
            def private(path):path=Path(path);path.mkdir(parents=True,exist_ok=True);return path
            def public(_):cache.mkdir(exist_ok=True);return cache
            def action(name):
                def perform(*args,**kwargs):
                    calls.append(name)
                    if failure==name:raise RuntimeError('controlled '+name)
                    if name=='rollback':
                        if args[1].get('appsResumed'):raise P.PrerequisiteError('Apps have resumed')
                        args[1]['phase']='rolled-back';P.save(args[0]/'journal.json',args[1])
                return perform
            with contextlib.ExitStack() as stack:
                for name,value in [('installed_packages',{'docker-ce':'1'}),('inventory',snapshot),('service_helpers',{}),('storage_requirements',[]),('requested_packages',{'docker-ce':'2'}),('simulate',review),('acquire_archives',{'docker-ce':{'version':'2'}}),('backup_packages',{'docker-ce':{'version':'1'}}),('same_inventory',True),('inspect',{'kind':'ready'}),('tools_required',False)]:stack.enter_context(mock.patch.object(P,name,return_value=value))
                def exclusivity(_installed):
                    calls.append('exclusivity')
                    if failure=='late-shared-runtime' and calls.count('exclusivity')==2:raise P.PrerequisiteError('Other workloads now share containerd')
                stack.enter_context(mock.patch.object(P,'require_exclusive_engine',side_effect=exclusivity))
                for name in ['prepare_repository','quiesce','checkpoint_storage','apply_packages','persist_repository','restore_workloads']:stack.enter_context(mock.patch.object(P,name,side_effect=action(name)))
                stack.enter_context(mock.patch.object(P,'rollback_engine',side_effect=action('rollback')))
                stack.enter_context(mock.patch.object(P,'private_directory',side_effect=private));stack.enter_context(mock.patch.object(P,'public_directory',side_effect=public))
                stack.enter_context(mock.patch.object(P,'run',side_effect=action('command')))
                if failure:
                    with self.assertRaises(P.PrerequisiteError):P.upgrade_existing('default',root,SYSTEM,{'kind':'upgrade'},lambda _:None)
                else:self.assertTrue(P.upgrade_existing('default',root,SYSTEM,{'kind':'upgrade'},lambda _:None)['changed'])
            identifier=json.loads((root/'current.json').read_text())['id'];journal=json.loads((root/identifier/'journal.json').read_text())
            return calls,journal
    def test_containerd_namespace_added_during_download_blocks_before_downtime(self):
        calls,journal=self.exercise('late-shared-runtime')
        self.assertEqual(calls.count('exclusivity'),2)
        self.assertIn('prepare_repository',calls)
        self.assertNotIn('quiesce',calls);self.assertNotIn('checkpoint_storage',calls);self.assertNotIn('apply_packages',calls)
        self.assertEqual(journal['phase'],'cancelled')

    def test_upgrade_retains_recovery_before_downtime_and_confirms_identity_before_resume(self):
        calls,journal=self.exercise()
        self.assertLess(calls.index('prepare_repository'),calls.index('quiesce'))
        self.assertLess(calls.index('quiesce'),calls.index('checkpoint_storage'))
        self.assertLess(calls.index('checkpoint_storage'),calls.index('apply_packages'))
        self.assertLess(calls.index('apply_packages'),calls.index('restore_workloads'))
        self.assertEqual(journal['phase'],'complete');self.assertTrue(journal['appsResumed'])
        self.assertEqual(journal['rollbackPackages'],{'docker-ce':{'version':'1'}})
    def test_package_failure_attempts_exact_recovery_before_any_app_resume(self):
        calls,journal=self.exercise('apply_packages')
        self.assertIn('rollback',calls);self.assertNotIn('restore_workloads',calls)
        self.assertEqual(journal['failedPhase'],'installing-required-packages');self.assertEqual(journal['phase'],'rolled-back')
    def test_repository_failure_does_not_pause_or_change_original_workloads(self):
        calls,journal=self.exercise('prepare_repository')
        self.assertNotIn('quiesce',calls);self.assertNotIn('apply_packages',calls);self.assertNotIn('rollback',calls)
        self.assertEqual(journal['phase'],'cancelled')
    def test_resume_failure_keeps_durable_no_storage_rollback_barrier(self):
        calls,journal=self.exercise('restore_workloads')
        self.assertTrue(journal['appsResumed']);self.assertEqual(journal['failedPhase'],'apps-resumed');self.assertEqual(journal['phase'],'recovery-required')

if __name__=='__main__':unittest.main(verbosity=2)

