"""Install boundaries use metadata/command recorders; no privileged commands."""
import stat
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import tempfile
import json
import subprocess
from contextlib import ExitStack

import installer
from installer import choose_identity, validate_path, validate_install


class InstallerTests(unittest.TestCase):
    def test_selects_lowest_unused_ids_and_refuses_same_uid_nobody_or_unowned_name(self):
        self.assertEqual(choose_identity({'api': 501, 'other': 503}, {'staff': 20, 'busy': 501}, 501), (502, 502))
        for users, groups, api, receipt in [({'_kinda_clock': 502}, {}, 501, None),
                                           ({'_kinda_clock': 501}, {'_kinda_clock': 502}, 501, {'producerUid': 501, 'producerGid': 502}),
                                           ({'_kinda_clock': -2}, {'_kinda_clock': -2}, 501, {'producerUid': -2, 'producerGid': -2}),
                                           ({'_kinda_clock': 502}, {'_kinda_clock': 502}, 501, {'producerUid': 503, 'producerGid': 502})]:
            with self.subTest(users=users), self.assertRaises(ValueError):
                choose_identity(users, groups, api, receipt)

    def test_rejects_symlink_writable_ancestor_or_interpreter_and_wrong_owner(self):
        def metadata(path):
            return SimpleNamespace(st_mode=stat.S_IFREG | 0o755 if path == '/usr/bin/python3' else stat.S_IFDIR | 0o755, st_uid=0)
        validate_path('/usr/bin/python3', metadata)
        for badpath, mode, uid in [('/usr', stat.S_IFDIR | 0o777, 0), ('/usr/bin/python3', stat.S_IFREG | 0o777, 0),
                                   ('/usr/bin', stat.S_IFLNK | 0o755, 0), ('/usr/bin/python3', stat.S_IFREG | 0o755, 501)]:
            def changed(path):
                return SimpleNamespace(st_mode=mode, st_uid=uid) if path == badpath else metadata(path)
            with self.subTest(path=badpath), self.assertRaises(ValueError):
                validate_path('/usr/bin/python3', changed)

    def test_nonroot_hash_drift_and_primary_drift_are_rejected_before_mutation(self):
        receipt = {'sourceCommit': 'a' * 40, 'fileHashes': {'daemon.py': 'b' * 64}, 'primary': {'pid': 123}}
        for uid, hashes, primary in [(501, receipt['fileHashes'], receipt['primary']),
                                      (0, {'daemon.py': 'c' * 64}, receipt['primary']),
                                      (0, receipt['fileHashes'], {'pid': 124})]:
            with self.subTest(uid=uid), self.assertRaises(ValueError):
                validate_install(receipt, uid, hashes, primary)

    def test_config_exact_fields_no_credentials_and_plist_fixed_isolated_identity(self):
        primary = dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                       pid=123, processStartedAt='Thu Oct 15 09:00:00 2026',
                       dataDirectory='/private/pg', executable='/opt/postgres/bin/postgres')
        config = dict(version=1, producerUid=502, producerGid=502, apiUid=501, primary=primary,
                      sourceCommit='a' * 40, fileHashes={name: 'b' * 64 for name in installer.FILES})
        self.assertEqual(installer.validate_config(config), config)
        for changes in [dict(password='x'), dict(apiUid=502), dict(producerUid=-2),
                        dict(primary=dict(primary, address='10.0.0.2')), dict(fileHashes={})]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                installer.validate_config(dict(config, **changes))
        plist = installer.launchd_plist(config)
        self.assertEqual(plist['ProgramArguments'], ['/usr/bin/python3', '-I', '-S', '/Library/Application Support/Kinda/ClockAttestor/daemon.py', '--config', '/Library/Application Support/Kinda/ClockAttestor/config.json'])
        self.assertEqual(plist['UserName'], '_kinda_clock')
        self.assertEqual(plist['GroupName'], '_kinda_clock')
        self.assertFalse(plist['InitGroups'])
        self.assertNotIn('EnvironmentVariables', plist)

    def test_producer_checks_process_without_reading_private_data_directory(self):
        primary = dict(pid=123, processStartedAt='Thu Oct 15 09:00:00 2026', executable='/opt/postgres/bin/postgres', dataDirectory='/private/pg')
        calls = []
        def run(argv):
            calls.append(argv)
            return 'Thu Oct 15 09:00:00 2026\n'
        with patch.object(Path, 'read_text', side_effect=PermissionError('private PG data')):
            self.assertTrue(installer.process_matches(primary, run, lambda pid: '/opt/postgres/bin/postgres'))
        self.assertEqual(calls, [('/bin/ps', '-p', '123', '-o', 'lstart=')])
        self.assertFalse(installer.process_matches(primary, run, lambda pid: '/other/postgres'))
        self.assertFalse(installer.process_matches(primary, lambda argv: 'later start', lambda pid: primary['executable']))

    def test_primary_file_binding_checks_postmaster_epoch_pid_port_and_local_host(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'postmaster.pid'
            path.write_text('123\n' + temp + '\n1792022400\n5432\n/tmp\nlocalhost\n0\nready\n')
            primary = dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                           pid=123, processStartedAt='Thu Oct 15 09:00:00 2026',
                           dataDirectory=temp, executable='/opt/postgres/bin/postgres')
            self.assertEqual(installer.verify_primary(primary, lambda value: True), primary)
            for field, value in [('pid', 124), ('port', 5433), ('startedAt', '2026-10-15T00:00:01.000Z'), ('address', '192.0.2.1')]:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    installer.verify_primary(dict(primary, **{field: value}), lambda value: True)
            with self.assertRaises(ValueError):
                installer.verify_primary(primary, lambda value: False)

    def test_atomic_state_json_preserves_exact_generation_object_and_private_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'generations.json'
            value = dict(stepGeneration=8, clearedStepGeneration=7, failoverGeneration=2, clearedFailoverGeneration=2)
            installer.atomic_json(path, value, 0o600)
            self.assertEqual(json.loads(path.read_text()), value)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_account_creation_and_bootstrap_record_exact_targets_only(self):
        calls = []
        installer.create_account(502, 503, lambda argv: calls.append(argv))
        self.assertIn(('/usr/bin/dscl', '.', '-create', '/Users/_kinda_clock', 'UniqueID', '502'), calls)
        self.assertIn(('/usr/bin/dscl', '.', '-create', '/Users/_kinda_clock', 'PrimaryGroupID', '503'), calls)
        self.assertIn(('/usr/bin/dscl', '.', '-create', '/Users/_kinda_clock', 'UserShell', '/usr/bin/false'), calls)
        self.assertIn(('/usr/bin/dscl', '.', '-create', '/Users/_kinda_clock', 'NFSHomeDirectory', '/var/empty'), calls)
        self.assertIn(('/usr/bin/dscl', '.', '-create', '/Users/_kinda_clock', 'Password', '*'), calls)
        self.assertTrue(all(command[0] == '/usr/bin/dscl' for command in calls))

    def test_receipt_expiry_foreign_fields_and_prepared_identity_are_rejected(self):
        config = dict(version=1, producerUid=502, producerGid=502, apiUid=501,
                      primary=dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                      pid=123, processStartedAt='Thu Oct 15 09:00:00 2026', dataDirectory='/private/pg', executable='/opt/bin/postgres'),
                      sourceCommit='a' * 40, fileHashes={name: 'b' * 64 for name in installer.FILES})
        receipt = dict(config, preparedAt=100, sourceRoot='/source/clock-attestor', installationId='d6c6ac76-bb54-4a68-b804-39597a2779ce')
        self.assertEqual(installer.validate_receipt(receipt, now=110), receipt)
        for value in [dict(receipt, preparedAt=1), dict(receipt, preparedAt=120), dict(receipt, databasePassword='secret')]:
            with self.subTest(receipt=value), self.assertRaises(ValueError):
                installer.validate_receipt(value, now=110)

    def test_install_nonroot_and_changed_source_never_create_accounts_or_files(self):
        calls = []
        with patch.object(installer.os, 'geteuid', return_value=501):
            with self.assertRaises(ValueError):
                installer.install_receipt({}, run=lambda argv: calls.append(argv))
        self.assertEqual(calls, [])

    def test_prepare_uses_only_read_commands_and_receipt_has_all_source_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            for name in installer.FILES:
                (source / name).write_text('reviewed ' + name)
            primary = dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                           pid=123, processStartedAt='Thu Oct 15 09:00:00 2026', dataDirectory='/private/pg', executable='/opt/bin/postgres')
            calls = []
            def run(argv):
                calls.append(argv)
                if '-list' in argv:
                    return 'api 501\n' if '/Users' in argv else 'staff 20\n'
                if 'rev-parse' in argv:
                    return 'a' * 40 + '\n'
                if 'status' in argv:
                    return ''
                raise AssertionError(argv)
            with patch.object(installer.os, 'geteuid', return_value=501), patch.object(installer, 'verify_primary', side_effect=lambda value: value), patch.object(installer, 'installed_receipt', return_value=None):
                receipt = installer.prepare_receipt(source, 501, primary, run=run, now=100)
            self.assertEqual(receipt['producerUid'], 502)
            self.assertEqual(set(receipt['fileHashes']), set(installer.FILES))
            self.assertEqual(receipt['sourceRoot'], str(source))
            self.assertTrue(all('-list' in argv or 'rev-parse' in argv or 'status' in argv for argv in calls))

    def test_root_prepare_rejects_before_source_identity_primary_hash_or_git(self):
        primary = dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                       pid=123, processStartedAt='Thu Oct 15 09:00:00 2026',
                       dataDirectory='/private/pg', executable='/opt/bin/postgres')
        source = Path('/user-owned/repo/scripts/clock-attestor')
        calls = []
        def run(argv):
            calls.append(argv)
            return 'a' * 40 if 'rev-parse' in argv else ''
        with ExitStack() as stack:
            euid = stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
            boundaries = [
                stack.enter_context(patch.object(Path, 'absolute', autospec=True, side_effect=lambda path: path)),
                stack.enter_context(patch.object(Path, 'is_symlink', return_value=False)),
                stack.enter_context(patch.object(installer, 'installed_receipt', return_value=None)),
                stack.enter_context(patch.object(installer, 'identities', return_value=({'api': 501}, {}))),
                stack.enter_context(patch.object(installer, 'verify_primary', side_effect=lambda value: value)),
                stack.enter_context(patch.object(installer, 'file_hashes', return_value={name: 'b' * 64 for name in installer.FILES})),
            ]
            with self.assertRaisesRegex(ValueError, '^nonroot_prepare_required$'):
                installer.prepare_receipt(source, 501, primary, run=run, now=100)
            for boundary in boundaries:
                boundary.assert_not_called()
            self.assertEqual(calls, [])
            # The same otherwise-valid fixture still prepares as a regular user;
            # root refusal cannot pass because some later field is invalid.
            euid.return_value = 501
            receipt = installer.prepare_receipt(source, 501, primary, run=run, now=100)
            self.assertEqual(installer.validate_receipt(receipt, now=100), receipt)
            self.assertEqual(calls, [('/usr/bin/git', '-C', str(source), 'rev-parse', 'HEAD'),
                                     ('/usr/bin/git', '-C', str(source), 'status', '--porcelain', '--', *installer.FILES)])

    def test_root_prepare_cli_rejects_before_primary_read_or_receipt_access(self):
        argv = ['installer.py', 'prepare', '--source', '/user-owned/repo/scripts/clock-attestor',
                '--api-uid', '501', '--primary-file', '/private/primary.json', '--receipt', '/private/new-receipt.json']
        with ExitStack() as stack:
            stack.enter_context(patch.object(installer.sys, 'argv', argv))
            stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
            boundaries = [stack.enter_context(patch.object(Path, 'exists', return_value=False)),
                          stack.enter_context(patch.object(Path, 'is_symlink', return_value=False)),
                          stack.enter_context(patch.object(installer, 'read_json', return_value={})),
                          stack.enter_context(patch.object(installer, 'prepare_receipt', return_value={})),
                          stack.enter_context(patch.object(installer, 'atomic_json'))]
            with self.assertRaisesRegex(ValueError, '^nonroot_prepare_required$'):
                installer.main()
            for boundary in boundaries:
                boundary.assert_not_called()

    def test_receipt_cannot_reuse_shared_uid_or_gid_alias(self):
        for users, groups in [({'_kinda_clock': 502, 'other': 502}, {'_kinda_clock': 503}),
                              ({'_kinda_clock': 502}, {'_kinda_clock': 503, 'other': 503})]:
            with self.subTest(users=users, groups=groups), self.assertRaises(ValueError):
                choose_identity(users, groups, 501, dict(producerUid=502, producerGid=503))

    def test_existing_account_must_still_be_nonlogin_and_password_disabled(self):
        values = {'UserShell': '/usr/bin/false', 'NFSHomeDirectory': '/var/empty', 'Password': '*', 'AuthenticationAuthority': ';DisabledUser;', 'PrimaryGroupID': '503'}
        def run(argv):
            return argv[-1] + ': ' + values[argv[-1]] + '\n'
        installer.verify_account(503, run)
        values['UserShell'] = '/bin/zsh'
        with self.assertRaises(ValueError):
            installer.verify_account(503, run)

    def test_privileged_check_never_executes_repository_git_filters(self):
        receipt = dict(sourceRoot='/source', sourceCommit='a' * 40, fileHashes={'core.py': 'b' * 64},
                       primary={}, apiUid=501, producerUid=502, producerGid=503)
        with ExitStack() as stack:
            stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(installer, 'validate_receipt'))
            stack.enter_context(patch.object(installer, 'file_hashes', return_value=receipt['fileHashes']))
            stack.enter_context(patch.object(installer, 'verify_primary'))
            stack.enter_context(patch.object(installer, 'installed_receipt', return_value=None))
            stack.enter_context(patch.object(installer, 'identities', return_value=({'api': 501}, {'staff': 501, 'busy': 502})))
            stack.enter_context(patch.object(installer, 'source_commit', side_effect=AssertionError('root must not execute repo git')))
            self.assertIsNone(installer.check_receipt(receipt))

    def test_install_stages_hashes_and_failure_stops_only_owned_label_preserving_state(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            source, prefix = root / 'source', root / 'installed'
            source.mkdir()
            for name in installer.FILES:
                (source / name).write_text('reviewed ' + name)
            primary = dict(startedAt='2026-10-15T00:00:00.000Z', address='127.0.0.1', port=5432,
                           pid=123, processStartedAt='Thu Oct 15 09:00:00 2026', dataDirectory='/private/pg', executable='/opt/bin/postgres')
            config = dict(version=1, producerUid=502, producerGid=503, apiUid=501, primary=primary,
                          sourceCommit='a' * 40, fileHashes=installer.file_hashes(source))
            receipt = dict(config, sourceRoot=str(source), preparedAt=100, installationId='d6c6ac76-bb54-4a68-b804-39597a2779ce')
            calls = []
            def run(argv):
                calls.append(argv)
                if 'bootstrap' in argv:
                    raise ValueError('injected launch failure')
                return ''
            for name, value in [('PREFIX', prefix), ('PLIST', root / 'launch.plist')]:
                stack.enter_context(patch.object(installer, name, value))
            for name in ('chown', 'fchown'):
                stack.enter_context(patch.object(installer.os, name))
            stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(installer.time, 'time', return_value=100))
            stack.enter_context(patch.object(installer, 'installed_receipt', return_value=None))
            stack.enter_context(patch.object(installer, 'identities', return_value=({'api': 501}, {'staff': 501, 'busy': 502})))
            stack.enter_context(patch.object(installer, 'source_commit', side_effect=AssertionError('root install must not execute repo git')))
            stack.enter_context(patch.object(installer, 'protected'))
            stack.enter_context(patch.object(installer, 'verify_primary', side_effect=lambda value: value))
            stack.enter_context(patch.object(installer, 'check_installed'))
            with self.assertRaises(ValueError):
                installer.install_receipt(receipt, run)
            self.assertEqual(installer.file_hashes(prefix), config['fileHashes'])
            self.assertEqual(json.loads((prefix / 'config.json').read_text()), config)
            self.assertEqual((prefix / 'state/generations.json').read_text(), '{}\n')
            self.assertEqual(calls[-1], ('/bin/launchctl', 'bootout', 'system/com.kinda.clock-attestor'))
            self.assertTrue(all('-delete' not in command for command in calls))
            self.assertEqual(stat.S_IMODE(prefix.stat().st_mode), 0o755)

    def test_isolated_cli_imports_only_explicit_verified_siblings(self):
        directory = Path(__file__).absolute().parent
        # Run real -I import semantics with only the filesystem trust syscall
        # injected. --help exits before OS/service/clock/socket boundaries.
        code = '''import os,sys,runpy,stat,subprocess
assert "site" not in sys.modules
subprocess.run=lambda argv,**kwargs: subprocess.CompletedProcess(argv,0,b"-rw-r--r-- 1 root wheel 10 Oct 15 00:00 fixture\\n",b"")
from pathlib import Path
from types import SimpleNamespace
original=Path.lstat
def metadata(path):
    value=original(path)
    return SimpleNamespace(st_mode=value.st_mode & ~0o022,st_uid=0)
Path.lstat=metadata
sys.argv=[sys.argv[1],"--help"]
runpy.run_path(sys.argv[0],run_name="__main__")
'''
        for name in ('daemon.py', 'operator.py', 'installer.py'):
            result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-c', code, str(directory / name)],
                                    capture_output=True, text=True, timeout=5, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(result.returncode, 0, name + ': ' + result.stderr)
            self.assertIn('usage:', result.stdout)

    def test_privileged_bootstrap_rejects_user_owned_sibling_before_import(self):
        directory = Path(__file__).absolute().parent
        code = '''import os,sys,runpy,stat,subprocess
subprocess.run=lambda argv,**kwargs: subprocess.CompletedProcess(argv,0,b"-rw-r--r-- 1 root wheel 10 Oct 15 00:00 fixture\\n",b"")
from pathlib import Path
from types import SimpleNamespace
original=Path.lstat
def metadata(path):
    value=original(path)
    return SimpleNamespace(st_mode=value.st_mode & ~0o022,st_uid=501 if path.name=="core.py" else 0)
Path.lstat=metadata
os.geteuid=lambda:0
sys.argv=[sys.argv[1],"--help"]
runpy.run_path(sys.argv[0],run_name="__main__")
'''
        for name in ('daemon.py', 'operator.py', 'installer.py'):
            result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-c', code, str(directory / name)], capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0, name)
            self.assertNotIn('usage:', result.stdout)

    def test_privileged_bootstrap_rejects_acl_before_local_import_sentinel(self):
        directory = Path(__file__).absolute().parent
        code = '''import os,sys,runpy,subprocess,builtins
from pathlib import Path
from types import SimpleNamespace
target=Path(sys.argv[2])
original_stat=Path.lstat
def metadata(path):
    value=original_stat(path)
    return SimpleNamespace(st_mode=value.st_mode & ~0o022,st_uid=0)
Path.lstat=metadata
os.geteuid=lambda:0
def run(argv,**kwargs):
    assert tuple(argv[:2])==("/bin/ls","-lde"),argv
    acl=Path(argv[-1])==target
    stdout=b"-rw-r--r--+ 1 root wheel 10 Oct 15 00:00 fixture\\n 0: user:501 allow write\\n" if acl else b"-rw-r--r-- 1 root wheel 10 Oct 15 00:00 fixture\\n"
    return subprocess.CompletedProcess(argv,0,stdout,b"")
subprocess.run=run
original_import=builtins.__import__
def observed_import(name,*args,**kwargs):
    if name in ("core","daemon","installer"):
        print("LOCAL_IMPORT_SENTINEL",flush=True)
    return original_import(name,*args,**kwargs)
builtins.__import__=observed_import
sys.argv=[sys.argv[1],"--help"]
runpy.run_path(sys.argv[0],run_name="__main__")
'''
        for name in ('daemon.py', 'operator.py', 'installer.py'):
            for target in (directory / 'core.py', directory.parent):
                with self.subTest(name=name, target=target):
                    result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-c', code,
                                             str(directory / name), str(target)], capture_output=True, text=True, timeout=5)
                    self.assertNotIn('LOCAL_IMPORT_SENTINEL', result.stdout)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('unprotected_program_acl', result.stderr)


if __name__ == '__main__':
    unittest.main()
