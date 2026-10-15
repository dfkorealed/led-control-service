"""Administrator clock-control client; no sample/primary injection or retry."""
import os
import sys
import stat
import socket
import subprocess
import threading
import time
import argparse
from pathlib import Path
from uuid import uuid4

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
    for item in (directory, *directory.parents):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('unprotected_program_path')
        bootstrap_acl(item)
    for name in ('core.py', 'daemon.py', 'installer.py', 'operator.py'):
        info = (directory / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('unprotected_program_file')
        bootstrap_acl(directory / name)
    sys.path.insert(0, str(directory))

from core import canonical_bytes, parse_request, parse_response
from daemon import receive_frame, send_frame, remaining_timeout, cancel_connection, PREFIX, SOCKET


def connect_socket(deadline):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        remaining_timeout(connection, deadline)
        connection.connect(str(SOCKET))
        return connection
    except Exception:
        connection.close()
        raise


def exchange(operation, observation_id=None, connect=None, producer_uid=None):
    if os.geteuid() != 0:
        raise PermissionError('root_control_required')
    if operation not in ('status', 'probe', 'approve'):
        raise ValueError('control_operation_required')
    if producer_uid is None:
        from installer import load_config, check_installed
        config = load_config(PREFIX / 'config.json')
        check_installed(config)
        producer_uid = config['producerUid']
        info = SOCKET.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != producer_uid:
            raise ValueError('socket_identity_invalid')
    request = dict(version=1, op=operation, nonce=str(uuid4()))
    if observation_id is not None:
        request['observationId'] = observation_id
    raw = canonical_bytes(request)
    parse_request(raw)
    deadline = time.monotonic() + 1
    connection = connect() if connect else connect_socket(deadline)
    timer = threading.Timer(max(0, deadline - time.monotonic()), cancel_connection, (connection,))
    timer.start()
    try:
        remaining_timeout(connection, deadline)
        if not hasattr(connection, 'getpeereid') or connection.getpeereid()[0] != producer_uid:
            raise PermissionError('producer_peer_invalid')
        send_frame(connection, raw, deadline)
        remaining_timeout(connection, deadline)
        connection.shutdown(socket.SHUT_WR)
        reply = parse_response(receive_frame(connection, deadline))
        if reply['nonce'] != request['nonce']:
            raise ValueError('response_nonce_mismatch')
        return reply
    finally:
        timer.cancel()
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('status', 'probe', 'approve'))
    parser.add_argument('--observation-id')
    args = parser.parse_args()
    result = exchange(args.operation, args.observation_id)
    sys.stdout.buffer.write(canonical_bytes(result))
    return 1 if result.get('status') == 'unavailable' else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit('clock_control_unavailable')
