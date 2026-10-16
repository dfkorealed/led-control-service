"""Protected installation; prepare/check never mutate OS configuration."""
import os
import stat
import sys
import argparse
import ctypes
import hashlib
import ipaddress
import json
import plistlib
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from uuid import UUID

def bootstrap_acl(path):
    # This gate must remain stdlib-only: importing a shared local helper before
    # checking its own ACL would cross the very boundary being established.
    try:
        result = subprocess.run(('/bin/ls', '-lde', str(path)), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2,
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, check=False)
        lines = result.stdout.splitlines()
        if (result.returncode or result.stderr or len(lines) != 1
                or not lines[0].split() or b'+' in lines[0].split()[0]):
            raise ValueError('acl_unavailable_or_present')
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('unprotected_program_acl')


if __name__ == '__main__':
    if not sys.flags.isolated or not sys.flags.no_site:
        raise SystemExit('python_isolated_no_site_required')
    directory = Path(__file__).absolute().parent
    if os.geteuid() == 0:
        for item in (directory, *directory.parents):
            info = item.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise SystemExit('root_requires_protected_staging')
            bootstrap_acl(item)
        for name in ('core.py', 'daemon.py', 'installer.py', 'operator.py'):
            info = (directory / name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise SystemExit('unprotected_program_file')
            bootstrap_acl(directory / name)
    sys.path.insert(0, str(directory))

from core import ClockTrustState, PrimaryBinding

FILES = ('core.py', 'daemon.py', 'installer.py', 'operator.py', 'protocol-v1.json')
PREFIX = Path('/Library/Application Support/Kinda/ClockAttestor')
PLIST = Path('/Library/LaunchDaemons/com.kinda.clock-attestor.plist')
LABEL = 'com.kinda.clock-attestor'
CONFIG_KEYS = {'version', 'producerUid', 'producerGid', 'apiUid', 'primary', 'sourceCommit', 'fileHashes'}
PRIMARY_KEYS = {'startedAt', 'address', 'port', 'pid', 'processStartedAt', 'dataDirectory', 'executable'}
SAFE_ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C', 'HOME': '/var/empty'}


def command(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=SAFE_ENV, timeout=2, check=False)
    if result.returncode or result.stderr or len(result.stdout) > 1048576:
        raise ValueError('command_failed')
    return result.stdout.decode('utf-8')


def primary_binding(primary):
    return PrimaryBinding(primary['startedAt'], primary['address'], primary['port'],
                          primary['pid'], primary['processStartedAt'])


def validate_primary(primary):
    if not isinstance(primary, dict) or set(primary) != PRIMARY_KEYS:
        raise ValueError('primary_shape_invalid')
    ClockTrustState(primary_binding(primary), '00000000-0000-4000-8000-000000000001', {})
    if primary['address'] is not None and not ipaddress.ip_address(primary['address']).is_loopback:
        raise ValueError('native_local_primary_required')
    if primary['port'] is None:
        raise ValueError('native_primary_port_required')
    for key in ('dataDirectory', 'executable'):
        if not isinstance(primary[key], str) or not Path(primary[key]).is_absolute() or '..' in Path(primary[key]).parts:
            raise ValueError('primary_path_invalid')
    if Path(primary['executable']).name != 'postgres':
        raise ValueError('postgres_executable_required')

def validate_config(config):
    if not isinstance(config, dict) or set(config) != CONFIG_KEYS or type(config['version']) is not int or config['version'] != 1:
        raise ValueError('config_shape_invalid')
    for key in ('producerUid', 'producerGid', 'apiUid'):
        if type(config[key]) is not int or not 501 <= config[key] <= 2147483647:
            raise ValueError('identity_invalid')
    if config['producerUid'] == config['apiUid']:
        raise ValueError('separate_identity_required')
    validate_primary(config['primary'])
    if not isinstance(config['sourceCommit'], str) or not re.fullmatch('[0-9a-f]{40}', config['sourceCommit']):
        raise ValueError('commit_invalid')
    if not isinstance(config['fileHashes'], dict) or set(config['fileHashes']) != set(FILES):
        raise ValueError('file_manifest_invalid')
    if any(not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value) for value in config['fileHashes'].values()):
        raise ValueError('file_hash_invalid')
    return config

def launchd_plist(config):
    validate_config(config)
    return dict(Label=LABEL, ProgramArguments=['/usr/bin/python3', '-I', '-S', str(PREFIX / 'daemon.py'),
                                               '--config', str(PREFIX / 'config.json')],
                UserName='_kinda_clock', GroupName='_kinda_clock', InitGroups=False,
                WorkingDirectory=str(PREFIX), RunAtLoad=True, KeepAlive=True,
                ThrottleInterval=10, Umask=0o077, ProcessType='Background',
                StandardOutPath='/dev/null', StandardErrorPath='/dev/null')


def process_executable(pid):
    if sys.platform != 'darwin':
        raise ValueError('darwin_required')
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    buffer = ctypes.create_string_buffer(4096)
    size = libproc.proc_pidpath(pid, buffer, len(buffer))
    if size <= 0:
        raise ValueError('process_identity_unavailable')
    return buffer.value.decode('utf-8')

def process_matches(primary, run=None, executable=None):
    run, executable = run or command, executable or process_executable
    try:
        # The producer never reads the private PostgreSQL data directory.
        started = run(('/bin/ps', '-p', str(primary['pid']), '-o', 'lstart=')).strip()
        return started == primary['processStartedAt'] and executable(primary['pid']) == primary['executable']
    except (OSError, ValueError, subprocess.SubprocessError):
        return False

def verify_primary(primary, matches=None):
    validate_primary(primary)
    lines = secure_read(Path(primary['dataDirectory']) / 'postmaster.pid').decode('utf-8').splitlines()
    started = datetime.strptime(primary['startedAt'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
    if (len(lines) < 8 or int(lines[0]) != primary['pid'] or lines[1] != primary['dataDirectory']
            or int(lines[2]) != int(started.timestamp()) or int(lines[3]) != primary['port']
            or lines[7] != 'ready' or not (matches or process_matches)(primary)):
        raise ValueError('primary_drift')
    return primary


def secure_read(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1048576:
            raise ValueError('regular_bounded_file_required')
        return stream.read(1048577)


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result
    return json.loads(secure_read(path).decode('utf-8'), object_pairs_hook=unique)


def atomic_bytes(path, data, mode, uid=None, gid=None):
    descriptor, temporary = tempfile.mkstemp(prefix='.clock-stage-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            if uid is not None:
                os.fchown(stream.fileno(), uid, gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path, value, mode):
    atomic_bytes(path, (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'), mode)

def create_account(uid, gid, run):
    for record, fields in [('/Groups/_kinda_clock', {'PrimaryGroupID': str(gid), 'Password': '*'}),
                            ('/Users/_kinda_clock', {'UniqueID': str(uid), 'PrimaryGroupID': str(gid),
                             'UserShell': '/usr/bin/false', 'NFSHomeDirectory': '/var/empty',
                             'Password': '*', 'AuthenticationAuthority': ';DisabledUser;', 'IsHidden': '1'})]:
        run(('/usr/bin/dscl', '.', '-create', record))
        for key, value in fields.items():
            run(('/usr/bin/dscl', '.', '-create', record, key, value))


def choose_identity(users, groups, api_uid, installed_receipt=None):
    name = '_kinda_clock'
    if type(api_uid) is not int or api_uid < 501:
        raise ValueError('api_uid_invalid')
    if name in users or name in groups:
        if (not installed_receipt or users.get(name) != installed_receipt.get('producerUid')
                or groups.get(name) != installed_receipt.get('producerGid')):
            raise ValueError('foreign_account')
        uid, gid = users[name], groups[name]
        if (uid < 501 or gid < 501 or uid == api_uid or list(users.values()).count(uid) != 1
                or list(groups.values()).count(gid) != 1):
            raise ValueError('unsafe_identity')
        return uid, gid
    def unused(values):
        candidate = 501
        while candidate in values:
            candidate += 1
        return candidate
    return unused(set(users.values()) | {api_uid}), unused(set(groups.values()))


def validate_path(path, metadata):
    target = Path(path)
    if not target.is_absolute():
        raise ValueError('absolute_path_required')
    for item in (target, *target.parents):
        info = metadata(str(item))
        if (stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
                or (item != target and not stat.S_ISDIR(info.st_mode))):
            raise ValueError('unprotected_path')
    if not (stat.S_ISREG(metadata(str(target)).st_mode) or stat.S_ISDIR(metadata(str(target)).st_mode)):
        raise ValueError('unsafe_path_type')


def validate_install(receipt, uid, hashes, primary):
    if uid != 0 or type(uid) is not int:
        raise ValueError('root_required')
    if receipt['fileHashes'] != hashes:
        raise ValueError('source_hash_drift')
    if receipt['primary'] != primary:
        raise ValueError('primary_drift')


def validate_receipt(receipt, now=None):
    if not isinstance(receipt, dict) or set(receipt) != CONFIG_KEYS | {'preparedAt', 'sourceRoot', 'installationId'}:
        raise ValueError('receipt_shape_invalid')
    validate_config({key: receipt[key] for key in CONFIG_KEYS})
    if (type(receipt['preparedAt']) not in (int, float)
            or not -1 <= (time.time() if now is None else now) - receipt['preparedAt'] <= 60):
        raise ValueError('fresh_receipt_required')
    if not isinstance(receipt['sourceRoot'], str) or not Path(receipt['sourceRoot']).is_absolute():
        raise ValueError('source_path_invalid')
    if str(UUID(receipt['installationId'])) != receipt['installationId']:
        raise ValueError('installation_identity_invalid')
    return receipt


def check_acl(path, run=command):
    # Reject any ACL, including inherited ACLs: POSIX mode checks alone do not
    # establish that an API account cannot replace an ancestor or executable.
    fields = run(('/bin/ls', '-lde', str(path))).splitlines()
    if not fields or '+' in fields[0].split()[0] or len(fields) != 1:
        raise ValueError('acl_not_supported')


def protected(path, run=command):
    validate_path(path, os.lstat)
    for item in (Path(path), *Path(path).parents):
        check_acl(item, run)


def protected_runtime_executable(path, run=command):
    # Apple's launcher reports a symlink under CommandLineTools. This exception
    # is executable-only: inspect every lexical component before following it,
    # including relative targets and intermediate directory links. resolve()
    # alone would hide a mutable link/ancestor behind a protected final file.
    value = str(path)
    if not Path(value).is_absolute() or Path(value).anchor != '/':
        raise ValueError('absolute_runtime_path_required')
    if len(value.encode('utf-8')) > 4096 or '\x00' in value:
        raise ValueError('runtime_path_too_long')

    def inspect(item):
        info = os.lstat(item)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unprotected_runtime_path')
        check_acl(item, run)
        return info

    current = Path('/')
    if not stat.S_ISDIR(inspect(current).st_mode):
        raise ValueError('runtime_directory_required')
    pending = value.split('/')[1:]
    links = steps = 0
    while pending:
        steps += 1
        if steps > 256 or len(str(current).encode('utf-8')) + sum(len(part.encode('utf-8')) + 1 for part in pending) > 4096:
            raise ValueError('runtime_path_too_long')
        part = pending.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            current = current.parent
            if not stat.S_ISDIR(inspect(current).st_mode):
                raise ValueError('runtime_directory_required')
            continue
        item = current / part
        info = inspect(item)
        if stat.S_ISLNK(info.st_mode):
            links += 1
            if links > 40:
                raise ValueError('runtime_link_limit')
            target = os.readlink(item)
            if not target or '\x00' in target or len(target.encode('utf-8')) > 4096:
                raise ValueError('invalid_runtime_link')
            if target.startswith('/'):
                current = Path('/')
            pending = target.split('/') + pending
            continue
        if pending:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError('runtime_directory_required')
            current = item
            continue
        if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
            raise ValueError('runtime_executable_required')
        return item
    raise ValueError('runtime_executable_required')


def file_hashes(source):
    return {name: hashlib.sha256(secure_read(source / name)).hexdigest() for name in FILES}


def load_config(path):
    protected(path)
    if stat.S_IMODE(path.lstat().st_mode) != 0o644:
        raise ValueError('config_mode_invalid')
    return validate_config(read_json(path))


def check_installed(config, private_state=True, run=command):
    validate_config(config)
    protected(Path('/usr/bin/python3'), run)
    # /usr/bin/python3 is Apple's launcher. Verify its actual stdlib/executable
    # installation as well; neither user site nor environment are imported by -I.
    runtime = json.loads(run(('/usr/bin/python3', '-I', '-S', '-c',
                             'import sys,sysconfig,json;print(json.dumps([sys.executable,sysconfig.get_path("stdlib")]))')))
    protected_runtime_executable(runtime[0], run)
    protected(Path(runtime[1]), run)
    for name in FILES:
        protected(PREFIX / name, run)
    if file_hashes(PREFIX) != config['fileHashes']:
        raise ValueError('installed_hash_drift')
    protected(PREFIX / 'config.json', run)
    for relative, mode in [('runtime', 0o755), ('state', 0o700)]:
        path = PREFIX / relative
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != config['producerUid'] or info.st_gid != config['producerGid'] or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError('private_directory_invalid')
        check_acl(path, run)
    if private_state:
        path = PREFIX / 'state/generations.json'
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != config['producerUid'] or info.st_gid != config['producerGid'] or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('state_permissions_invalid')
        check_acl(path, run)


def installed_receipt():
    if not PREFIX.exists() and not PREFIX.is_symlink():
        if PLIST.exists() or PLIST.is_symlink():
            raise ValueError('foreign_launchd_file')
        return None
    protected(PREFIX)
    path = PREFIX / 'receipt.json'
    protected(path)
    receipt = read_json(path)
    # Historical protected receipt proves ownership, not freshness of a new install.
    validate_receipt(receipt, now=receipt.get('preparedAt', 0))
    config = load_config(PREFIX / 'config.json')
    if config != {key: receipt[key] for key in CONFIG_KEYS}:
        raise ValueError('installed_receipt_mismatch')
    check_installed(config, private_state=False)
    protected(PLIST)
    if plistlib.loads(secure_read(PLIST)) != launchd_plist(config):
        raise ValueError('foreign_launchd_file')
    return receipt


def identities(run):
    result = []
    for directory, attribute in [('/Users', 'UniqueID'), ('/Groups', 'PrimaryGroupID')]:
        values = {}
        for line in run(('/usr/bin/dscl', '.', '-list', directory, attribute)).splitlines():
            name, number = line.rsplit(None, 1)
            if name in values:
                raise ValueError('duplicate_directory_identity')
            values[name] = int(number)
        result.append(values)
    return result


def verify_account(gid, run=command):
    expected = {'UserShell': '/usr/bin/false', 'NFSHomeDirectory': '/var/empty',
                'Password': '*', 'AuthenticationAuthority': ';DisabledUser;', 'PrimaryGroupID': str(gid)}
    for key, value in expected.items():
        observed = run(('/usr/bin/dscl', '.', '-read', '/Users/_kinda_clock', key)).strip()
        if observed != key + ': ' + value:
            raise ValueError('service_account_changed')


def source_commit(source, run):
    commit = run(('/usr/bin/git', '-C', str(source), 'rev-parse', 'HEAD')).strip()
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('source_commit_invalid')
    if run(('/usr/bin/git', '-C', str(source), 'status', '--porcelain', '--', *FILES)).strip():
        raise ValueError('reviewed_clean_source_required')
    return commit

def prepare_receipt(source, api_uid, primary, run=command, now=None):
    # Preparing consults mutable repository Git configuration; root must stop
    # before even inspecting source, identities, primary, or hashes.
    if os.geteuid() == 0:
        raise ValueError('nonroot_prepare_required')
    source = Path(source).absolute()
    if source.is_symlink():
        raise ValueError('source_symlink')
    old = installed_receipt()
    users, groups = identities(run)
    uid, gid = choose_identity(users, groups, api_uid, old)
    if old:
        verify_account(gid, run)
    receipt = dict(version=1, producerUid=uid, producerGid=gid, apiUid=api_uid,
                   primary=verify_primary(primary), sourceCommit=source_commit(source, run),
                   fileHashes=file_hashes(source), sourceRoot=str(source),
                   preparedAt=time.time() if now is None else now,
                   installationId=old['installationId'] if old else str(uuid4()))
    return validate_receipt(receipt, now=now)


def check_receipt(receipt, run=command):
    validate_receipt(receipt)
    source = Path(receipt['sourceRoot'])
    # Privileged installs trust the independently pinned root-protected receipt,
    # never git filters/fsmonitor in a mutable user repository.
    if (os.geteuid() != 0 and source_commit(source, run) != receipt['sourceCommit']) or file_hashes(source) != receipt['fileHashes']:
        raise ValueError('source_drift')
    verify_primary(receipt['primary'])
    old = installed_receipt()
    if old and old['installationId'] != receipt['installationId']:
        raise ValueError('foreign_receipt')
    uid, gid = choose_identity(*identities(run), receipt['apiUid'], old)
    if (uid, gid) != (receipt['producerUid'], receipt['producerGid']):
        raise ValueError('identity_drift')
    if old:
        verify_account(gid, run)
    return old

def install_receipt(receipt, run=command):
    if os.geteuid() != 0:
        raise ValueError('root_required')
    old = check_receipt(receipt, run)
    validate_install(receipt, os.geteuid(), file_hashes(Path(receipt['sourceRoot'])), verify_primary(receipt['primary']))
    protected(Path('/usr/bin/python3'), run)
    protected(PLIST.parent, run)
    for parent in reversed(PREFIX.parents):
        if parent.exists():
            protected(parent, run)
        else:
            parent.mkdir(mode=0o755)
            parent.chmod(0o755)
    if old is None and (PREFIX.exists() or PREFIX.is_symlink()):
        raise ValueError('foreign_installation')
    staging = Path(tempfile.mkdtemp(prefix='.clock-staging-', dir=PREFIX.parent))
    # Source bytes cross the privilege boundary once into root0700 staging, then
    # each copied byte sequence is hashed against the freshly checked receipt.
    for name in FILES:
        data = secure_read(Path(receipt['sourceRoot']) / name)
        if hashlib.sha256(data).hexdigest() != receipt['fileHashes'][name]:
            raise ValueError('source_hash_drift')
        atomic_bytes(staging / name, data, 0o644, 0, 0)
    if file_hashes(staging) != receipt['fileHashes']:
        raise ValueError('staging_hash_drift')
    # Recheck immediately before the first account/service mutation.
    check_receipt(receipt, run)
    uid, gid = receipt['producerUid'], receipt['producerGid']
    if old:
        run(('/bin/launchctl', 'bootout', 'system/' + LABEL))
    else:
        create_account(uid, gid, run)
        PREFIX.mkdir(mode=0o755)
        PREFIX.chmod(0o755)
        for relative, mode in [('runtime', 0o755), ('state', 0o700)]:
            path = PREFIX / relative
            path.mkdir(mode=mode)
            path.chmod(mode)
            os.chown(path, uid, gid)
        atomic_bytes(PREFIX / 'state/generations.json', b'{}\n', 0o600, uid, gid)
    config = {key: receipt[key] for key in CONFIG_KEYS}
    try:
        for name in FILES:
            atomic_bytes(PREFIX / name, secure_read(staging / name), 0o644, 0, 0)
        atomic_json(PREFIX / 'config.json', config, 0o644)
        atomic_json(PREFIX / 'receipt.json', receipt, 0o644)
        atomic_bytes(PLIST, plistlib.dumps(launchd_plist(config)), 0o644, 0, 0)
        check_installed(config, run=run)
        verify_primary(receipt['primary'])
        run(('/bin/launchctl', 'bootstrap', 'system', str(PLIST)))
    except Exception:
        # Rollback stops only our exact label. Account/state/staging survive for
        # diagnosis; never delete/recreate generations or another service.
        try:
            run(('/bin/launchctl', 'bootout', 'system/' + LABEL))
        except Exception:
            pass
        raise
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('check', 'prepare', 'install', 'status'))
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--primary-file', type=Path)
    parser.add_argument('--api-uid', type=int)
    parser.add_argument('--source', type=Path, default=Path(__file__).absolute().parent)
    args = parser.parse_args()
    if args.operation == 'prepare':
        # Reject before CLI input/receipt I/O as well as inside prepare_receipt.
        if os.geteuid() == 0:
            raise ValueError('nonroot_prepare_required')
        if args.primary_file is None or args.api_uid is None:
            parser.error('prepare requires --primary-file and --api-uid')
        if args.receipt.exists() or args.receipt.is_symlink():
            raise ValueError('new_receipt_path_required')
        receipt = prepare_receipt(args.source, args.api_uid, read_json(args.primary_file))
        atomic_json(args.receipt.absolute(), receipt, 0o600)
        print(json.dumps(receipt, sort_keys=True))
    elif args.operation == 'status':
        receipt = installed_receipt()
        if receipt is None:
            print('{"installed":false}')
        else:
            # No health claim: launchd presence is distinct from sample approval.
            command(('/bin/launchctl', 'print', 'system/' + LABEL))
            print(json.dumps(dict(installed=True, sourceCommit=receipt['sourceCommit'], producerUid=receipt['producerUid'])))
    else:
        if args.operation == 'install':
            protected(args.receipt.absolute())
            if stat.S_IMODE(args.receipt.stat().st_mode) != 0o600:
                raise ValueError('protected_receipt_required')
        receipt = read_json(args.receipt)
        if args.operation == 'check':
            check_receipt(receipt)
            print('{"checked":true}')
        else:
            install_receipt(receipt)
            print('{"installed":true,"approved":false}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('clock_attestor_installation_unavailable')
