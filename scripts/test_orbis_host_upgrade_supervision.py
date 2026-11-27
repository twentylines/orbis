import copy
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('upgrade_supervision_under_test',HERE/'orbis-host-upgrade-supervision.py')
S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)


class Authority:
    """Local identity substitute; actual production uses the Root authority."""
    @contextmanager
    def protected_directory(self,path,**options):
        yield Path(path)

    @contextmanager
    def protected_file(self,parent,name,maximum,**options):
        path=parent/name
        before=path.lstat()
        # macOS's system Python has shared hard links. This local stand-in
        # substitutes Linux interpreter custody; production authority is intact.
        if not stat.S_ISREG(before.st_mode) or (before.st_nlink!=1 and not options.get('digest_only')) or before.st_mode&0o022:
            raise ValueError('untrusted local fixture')
        body=path.read_bytes()
        if len(body)>maximum:
            raise ValueError('oversize fixture')
        yield S.sha(body) if options.get('digest_only') else body
        fields=lambda info:(info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        if fields(path.lstat())!=fields(before) or path.read_bytes()!=body:
            raise ValueError('changed local fixture')


class Target:
    def __init__(self,directory):
        self.value={'selectionDirectory':str(directory),'sourceSelectionSha256':'a'*64,'sourceExecutionSha256':'b'*64}
        self.active=True

    @property
    def sha256(self):
        self.verify();return S.sha(S.canonical(self.value))

    def verify(self):
        if not self.active:
            raise ValueError('source lease was closed')

    def manifest(self):
        self.verify();return copy.deepcopy(self.value)


class Runtime:
    def __init__(self,state,operation,target):
        self.supported_calls=0
        self.boot_id=str(uuid.uuid4())
        self.properties={'LoadState':'loaded','FragmentPath':str(S.UNITS/S.unit_name(operation)),
            'DropInPaths':'','NeedDaemonReload':'no','Type':'exec','Restart':'no','RemainAfterExit':'no',
            'KillMode':'control-group','User':'root','Group':'root','ControlGroup':'/system.slice/'+S.unit_name(operation),
            'ActiveState':'active','SubState':'running','MainPID':str(os.getpid()),'ControlPID':'0','InvocationID':'c'*32,
            'Job':''}
        self.process_value={'pid':os.getpid(),'parent':1,'startTime':123,'argv':[os.fsencode(item) for item in
            S.executor_argv(state,operation,target.value['sourceSelectionSha256'],'d'*64,'stable')],
            'executable':str(S.PYTHON.resolve()),'invocationId':'c'*32,'cgroup':self.properties['ControlGroup']}

    def supported(self): self.supported_calls+=1
    def unit(self,_name): return copy.deepcopy(self.properties)
    def process(self,_pid): return copy.deepcopy(self.process_value)
    def boot(self): return self.boot_id


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.operation=str(uuid.uuid4());self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.units=self.root/'units';self.units.mkdir()
        patch=mock.patch.object(S,'UNITS',self.units);patch.start();self.addCleanup(patch.stop)
        self.target=Target(S.operation_directory(self.state,self.operation)/'selection')
        self.unit_file=self.units/S.unit_name(self.operation)
        self.unit_file.write_bytes(S.unit_body(self.state,self.operation));self.unit_file.chmod(0o644)
        self.runtime=Runtime(self.state,self.operation,self.target)
        self.authority=Authority()

    def bind(self):
        return S.BoundSupervisor(self.authority,self.target,self.state,self.operation,'d'*64,'stable',runtime=self.runtime)

    def test_same_live_kernel_unit_and_verified_source_frame_remains_bound(self):
        bound=self.bind();frame=bound.verify()
        self.assertEqual(frame['pid'],os.getpid())
        self.assertEqual(frame['sourceExecutionSha256'],'b'*64)
        self.assertEqual(frame['targetManifestSha256'],self.target.sha256)
        self.assertGreaterEqual(self.runtime.supported_calls,2)
        frame['pid']=1
        self.assertEqual(bound.verify()['pid'],os.getpid())

    def test_bootstrap_observation_binds_the_actual_fixed_launcher_process(self):
        expected = S.launcher_argv(self.state, self.operation)
        self.runtime.process_value['argv'] = [os.fsencode(value) for value in expected]
        observed = S.observe_invocation(self.authority, self.state, self.operation, expected,
                                        runtime=self.runtime, current=True)
        self.assertEqual(observed['pid'], os.getpid())
        self.assertEqual(observed['unit'], S.unit_name(self.operation))
        self.assertNotIn('sourceExecutionSha256', observed)
        self.runtime.process_value['argv'].append(b'--unreviewed')
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_invocation(self.authority, self.state, self.operation, expected,
                                 runtime=self.runtime, current=True)

    def test_reconciliation_has_a_distinct_fixed_unit_and_command(self):
        name=S.reconciliation_unit_name(self.operation)
        (self.units/name).write_bytes(S.unit_body(self.state,self.operation,reconciling=True))
        (self.units/name).chmod(0o644)
        expected=S.launcher_argv(self.state,self.operation,reconciling=True)
        self.runtime.properties.update(FragmentPath=str(self.units/name),ControlGroup='/system.slice/'+name)
        self.runtime.process_value.update(argv=[os.fsencode(value) for value in expected],cgroup='/system.slice/'+name)
        observed=S.observe_invocation(self.authority,self.state,self.operation,expected,
                                     runtime=self.runtime,current=True,reconciling=True)
        self.assertEqual(observed['unit'],name)
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_invocation(self.authority,self.state,self.operation,expected,
                                 runtime=self.runtime,current=True)

    def quiescent_runtime(self):
        original={'bootId':self.runtime.boot_id,'pid':41,'startTime':123,'invocationId':'c'*32,
                  'unit':S.unit_name(self.operation),'unitSha256':S.sha(self.unit_file.read_bytes())}
        self.runtime.properties.update(ActiveState='inactive',SubState='dead',MainPID='0')
        self.runtime.generation_gone=lambda frame,boot:True
        self.runtime.cgroup_empty=lambda name:True
        return original

    def test_quiescence_requires_both_stopped_unit_and_absent_process_generation(self):
        original=self.quiescent_runtime()
        observed=S.observe_quiescence(self.authority,self.state,self.operation,original,runtime=self.runtime)
        self.assertTrue(observed['quiescent'])
        self.runtime.generation_gone=lambda *args:False
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_quiescence(self.authority,self.state,self.operation,original,runtime=self.runtime)

    def test_quiescence_refuses_remaining_descendants_or_changed_old_unit(self):
        original=self.quiescent_runtime()
        self.runtime.cgroup_empty=lambda name:False
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_quiescence(self.authority,self.state,self.operation,original,runtime=self.runtime)
        self.runtime.cgroup_empty=lambda name:True
        self.runtime.properties['KillMode']='process'
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_quiescence(self.authority,self.state,self.operation,original,runtime=self.runtime)

    def test_unclaimed_unit_file_is_safe_before_daemon_reload_only_without_activation_job(self):
        self.quiescent_runtime()
        self.runtime.properties.update(LoadState='not-found', FragmentPath='', ControlGroup='', InvocationID='',
                                       ActiveState='inactive', SubState='dead')
        self.assertTrue(S.observe_quiescence(self.authority,self.state,self.operation,None,
                                             runtime=self.runtime)['quiescent'])
        self.runtime.properties['Job'] = '42'
        with self.assertRaises(S.UpgradeSupervisionError):
            S.observe_quiescence(self.authority,self.state,self.operation,None,runtime=self.runtime)

    def test_host_reader_cannot_claim_a_stale_or_other_control_group_process(self):
        expected = S.launcher_argv(self.state, self.operation)
        self.runtime.process_value['argv'] = [os.fsencode(value) for value in expected]
        original = copy.deepcopy(self.runtime.properties)
        for key, value in {'MainPID': '0', 'ControlPID': '2', 'ActiveState': 'inactive',
                           'ControlGroup': '/system.slice/orbis-host.service'}.items():
            self.runtime.properties = {**original, key: value}
            with self.subTest(key=key), self.assertRaises(S.UpgradeSupervisionError):
                S.observe_invocation(self.authority, self.state, self.operation, expected, runtime=self.runtime)

    def test_only_fixed_uuid_unit_and_quoted_closed_argv_can_be_constructed(self):
        for operation in ('../other','a\nExecStart=/bin/sh','0'*36,str(uuid.uuid5(uuid.NAMESPACE_DNS,'upgrade.invalid'))):
            with self.subTest(operation=operation),self.assertRaises(S.UpgradeSupervisionError):
                S.unit_body(self.state,operation)
        text=S.unit_body('/var/lib/a % "b',self.operation).decode()
        self.assertIn('%%',text);self.assertIn('\\"',text)
        self.assertEqual(text.count('ExecStart='),1)
        self.assertIn('Restart=no',text)
        self.assertIn('RemainAfterExit=no',text)
        self.assertNotIn('orbis-host.service\n',text)

    def test_pid_unit_state_control_group_and_loaded_profile_cannot_be_claimed_by_json(self):
        variants={'MainPID':'1','DropInPaths':'/run/override.conf','KillMode':'process',
            'ControlGroup':'/system.slice/orbis-host.service','NeedDaemonReload':'yes',
            'FragmentPath':'/run/other.service','ControlPID':'2','User':'nobody','Group':'other',
            'Type':'simple','Restart':'always','RemainAfterExit':'yes','SubState':'exited','ActiveState':'inactive'}
        original=copy.deepcopy(self.runtime.properties)
        for key,value in variants.items():
            self.runtime.properties={**original,key:value}
            with self.subTest(key=key),self.assertRaises(S.UpgradeSupervisionError): self.bind()
        self.runtime.properties=original

    def test_source_command_interpreter_and_parent_identity_are_required(self):
        original=copy.deepcopy(self.runtime.process_value)
        for key,value in [('argv',original['argv']+[b'--force']),('executable','/usr/bin/other-python'),
                          ('cgroup','/system.slice/orbis-host.service'),('parent',42),('pid',1),
                          ('startTime',0),('invocationId','f'*32)]:
            self.runtime.process_value={**original,key:value}
            with self.subTest(key=key),self.assertRaises(S.UpgradeSupervisionError): self.bind()
        self.runtime.process_value=original

    def test_reused_pid_new_boot_new_invocation_and_changed_source_invalidate_a_bound_scope(self):
        bound=self.bind()
        old=self.runtime.boot_id;self.runtime.boot_id=str(uuid.uuid4())
        with self.assertRaises(S.UpgradeSupervisionError):bound.verify()
        self.runtime.boot_id=old
        self.runtime.process_value['startTime']+=1
        with self.assertRaises(S.UpgradeSupervisionError):bound.verify()
        self.runtime.process_value['startTime']-=1
        self.runtime.process_value['invocationId']=self.runtime.properties['InvocationID']='f'*32
        with self.assertRaises(S.UpgradeSupervisionError):bound.verify()
        self.runtime.process_value['invocationId']=self.runtime.properties['InvocationID']='c'*32
        self.target.value['sourceExecutionSha256']='e'*64
        with self.assertRaises(S.UpgradeSupervisionError):bound.verify()

    def test_different_source_namespace_and_closed_source_lease_cannot_bind(self):
        original=self.target.value['selectionDirectory']
        self.target.value['selectionDirectory']=str(self.root/'other-selection')
        with self.assertRaises(S.UpgradeSupervisionError):self.bind()
        self.target.value['selectionDirectory']=original;self.target.active=False
        with self.assertRaises(ValueError):self.bind()

    def test_changed_unit_bytes_and_symlink_are_preserved_without_binding(self):
        original=self.unit_file.read_bytes();self.unit_file.write_bytes(original+b'\n')
        with self.assertRaises(S.UpgradeSupervisionError):self.bind()
        self.assertEqual(self.unit_file.read_bytes(),original+b'\n')
        self.unit_file.unlink();self.unit_file.symlink_to(self.root/'elsewhere')
        with self.assertRaises(ValueError):self.bind()
        self.assertTrue(self.unit_file.is_symlink())

    def test_observation_race_never_returns_an_admission_frame(self):
        unit=self.runtime.unit;counter=0
        def raced(name):
            nonlocal counter
            counter+=1
            result=unit(name)
            if counter>1: result['InvocationID']='f'*32
            return result
        self.runtime.unit=raced
        with self.assertRaises(S.UpgradeSupervisionError):self.bind()


class KernelParsingTests(unittest.TestCase):
    def runtime(self):
        runtime=S.Runtime()
        fields=['S','1']+['0']*17+['123']+['0']*3
        # Fields above begin at Linux stat field3; index19 is starttime.
        bodies={'stat':('42 (worker with ) parentheses) '+' '.join(fields)).encode(),
                'cmdline':b'/usr/bin/python3\0-I\0worker.py\0','environ':b'UNRELATED=private\0INVOCATION_ID='+b'a'*32+b'\0',
                'cgroup':b'0::/system.slice/example.service\n'}
        runtime.read=lambda location,limit:bodies[location.name]
        return runtime,bodies

    def test_process_parser_handles_parentheses_without_exporting_environment(self):
        runtime,bodies=self.runtime()
        with mock.patch.object(S.os,'readlink',return_value='/usr/bin/python3'):
            result=runtime.process(42)
        self.assertEqual(result['startTime'],123)
        self.assertEqual(result['parent'],1)
        self.assertNotIn('UNRELATED',repr(result))
        self.assertNotIn('private',repr(result))

    def test_duplicate_invocation_unknown_cgroup_and_pid_reuse_are_refused(self):
        for key,value in [('environ',b'INVOCATION_ID='+b'a'*32+b'\0INVOCATION_ID='+b'a'*32+b'\0'),
                          ('cgroup',b'0::/one\n1:cpu:/two\n'),('cmdline',b'unterminated')]:
            runtime,bodies=self.runtime();bodies[key]=value
            with self.subTest(key=key),mock.patch.object(S.os,'readlink',return_value='/usr/bin/python3'),self.assertRaises(S.UpgradeSupervisionError):
                runtime.process(42)

    def test_unsupported_operator_is_refused_before_any_kernel_read(self):
        runtime=S.Runtime()
        with mock.patch.object(S.sys,'platform','darwin'),mock.patch.object(runtime,'read') as read,self.assertRaises(S.UpgradeSupervisionError):
            runtime.supported()
        read.assert_not_called()

    def test_systemd_properties_reject_duplicate_extra_and_missing_fields(self):
        runtime=S.Runtime()
        base=''.join(key+'=value\n' for key in S.PROPERTIES).encode()
        for body in (base+b'User=root\n',base+b'Unknown=x\n',b'User=root\n'):
            result=type('Result',(),{'returncode':0,'stdout':body})()
            with self.subTest(body=body),mock.patch.object(S.subprocess,'run',return_value=result),self.assertRaises(S.UpgradeSupervisionError):
                runtime.unit('fixed.service')

    def test_systemd_observation_timeout_cannot_prove_quiescence(self):
        with (mock.patch.object(S.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 5)),
              self.assertRaises(S.UpgradeSupervisionError)):
            S.Runtime().unit('fixed.service')


if __name__=='__main__':unittest.main()
