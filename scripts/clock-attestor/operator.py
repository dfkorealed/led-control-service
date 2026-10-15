"""Administrator clock-control client; no sample/primary injection or retry."""
import os
import sys
import stat
import socket
import threading
import argparse
from pathlib import Path
from uuid import uuid4

if __name__ == '__main__':
    if not sys.flags.isolated or not sys.flags.no_site:
        raise SystemExit('python_isolated_no_site_required')
    directory = Path(__file__).absolute().parent
    for item in (directory, *directory.parents):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('unprotected_program_path')
    for name in ('core.py', 'daemon.py', 'installer.py', 'operator.py'):
        info = (directory / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('unprotected_program_file')
    sys.path.insert(0, str(directory))

from core import canonical_bytes, parse_request, parse_response
from daemon import receive_frame, PREFIX, SOCKET


def connect_socket():
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(1)
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
    connection = (connect or connect_socket)()
    timer = threading.Timer(1, connection.close)
    timer.start()
    try:
        connection.settimeout(1)
        if not hasattr(connection, 'getpeereid') or connection.getpeereid()[0] != producer_uid:
            raise PermissionError('producer_peer_invalid')
        connection.sendall(raw)
        connection.shutdown(socket.SHUT_WR)
        reply = parse_response(receive_frame(connection))
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
