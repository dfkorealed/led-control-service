"""Independent Mac clock producer; external effects live at the module boundary."""
import argparse
import ctypes
import fcntl
import os
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# -I deliberately excludes the script directory. Add only the verified installation
# directory, never cwd/PYTHONPATH; tests import through their own discovery path.
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

from core import ClockSample, ClockTrustState, MAX_FRAME_BYTES, canonical_bytes, parse_request, parse_sntp

PREFIX = Path('/Library/Application Support/Kinda/ClockAttestor')
SOCKET = PREFIX / 'runtime/evidence.sock'
SNTP_ARGV = ('/usr/bin/sntp', '-t', '1', 'time.apple.com')
SAFE_ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C', 'HOME': '/var/empty'}


def acquire_state_lock(path, uid):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('state_lock_invalid')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def timestamp(wall_ms):
    return datetime.fromtimestamp(wall_ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


@dataclass(frozen=True)
class SntpResult:
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool


class ClockService:
    def __init__(self, api_uid, primary, generations, observe, collect, persist, boot_id):
        self.api_uid = api_uid
        self.observe_system, self.collect, self.persist = observe, collect, persist
        self.state = ClockTrustState(primary, boot_id, generations)
        self.condition = threading.Condition(threading.RLock())
        self.stopped = False
        self.collecting = False
        self.bracket_origin = None
        self.max_bracket_ms = 0
        self.sample_wall = None
        self.last_collection_ok = False
        self.saved = None
        self._persist()

    def _persist(self):
        current = dict(self.state.persisted_generations)
        if current != self.saved:
            try:
                self.persist(current)
                self.saved = current
            except Exception:
                # Never serve after a durability error, even if a subsequent write works.
                self.stopped = True
                raise

    def _observe(self):
        wall, continuous, matches = self.observe_system()
        if self.collecting and self.bracket_origin is not None:
            origin_wall, origin_continuous = self.bracket_origin
            self.max_bracket_ms = max(self.max_bracket_ms, abs(wall - origin_wall - (continuous - origin_continuous) / 1000000))
        self.state.observe(wall, continuous, matches)
        self._persist()
        return wall, continuous

    def tick(self):
        with self.condition:
            if not self.stopped:
                self._observe()

    def _sample(self, force, request_valid):
        with self.condition:
            wall, continuous = self._observe()
            if self.stopped or not request_valid():
                return False
            if self.collecting:
                # One worker owns collection. Waiters consume that original measurement,
                # including probes: coalescing never counts as a second independent sample.
                if not self.condition.wait_for(lambda: not self.collecting or self.stopped, 0.8):
                    return False
                self._observe()
                return not self.stopped and self.last_collection_ok
            if not force and self.sample_wall is not None and 0 <= wall - self.sample_wall < 1000:
                return self.last_collection_ok
            self.collecting = True
            start_wall, start_continuous = wall, continuous
            self.bracket_origin = (wall, continuous)
            self.max_bracket_ms = 0
        result = None
        try:
            result = self.collect()
        except Exception:
            pass
        finally:
            with self.condition:
                try:
                    end_wall, end_continuous = self._observe()
                    elapsed = (end_continuous - start_continuous) / 1000000
                    valid = (not self.stopped and request_valid() and result is not None and not result.timed_out
                             and result.returncode == 0 and result.stderr == '' and 0 < elapsed <= 750)
                    if not valid:
                        raise ValueError('collection_unavailable')
                    offset, uncertainty = parse_sntp(result.stdout)
                    bracket = self.max_bracket_ms
                    self.state.record_sample(ClockSample(timestamp(start_wall), offset, uncertainty, bracket))
                    self.last_collection_ok = self.state.status()['consecutiveSamples'] > 0
                    self.sample_wall = start_wall
                except Exception:
                    self.state.record_sample(None)
                    # Failed read requests share a one-second backoff. This is
                    # an unavailable cache, never a synthetic healthy sample.
                    self.sample_wall = start_wall
                    self.last_collection_ok = False
                finally:
                    self.collecting = False
                    self.condition.notify_all()
        return self.last_collection_ok and not self.stopped

    def handle(self, raw, uid, request_valid=lambda: True):
        if type(uid) is not int or uid not in (0, self.api_uid):
            raise PermissionError('peer_denied')
        message = parse_request(raw)
        op, nonce = message['op'], message['nonce']
        if (op == 'read' and uid != self.api_uid) or (op != 'read' and uid != 0):
            raise PermissionError('operation_denied')
        if op in ('read', 'probe'):
            sampled = self._sample(op == 'probe', request_valid)
        else:
            sampled = True
        with self.condition:
            self._observe()
            if self.stopped or not sampled or not request_valid():
                body = dict(status='unavailable', reason='sample_unavailable')
            elif op == 'read':
                return canonical_bytes(self.state.evidence(nonce))
            elif op == 'approve':
                try:
                    self.state.approve(message['observationId'], uid)
                    self._persist()
                    body = self.state.status()
                except ValueError:
                    body = dict(status='unavailable', reason='not_approved')
            else:
                body = self.state.status()
            return canonical_bytes(dict(version=1, nonce=nonce, **body))

    def stop(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()


def receive_frame(connection):
    raw = bytearray()
    while True:
        chunk = connection.recv(MAX_FRAME_BYTES + 1 - len(raw))
        if not chunk:
            break
        raw.extend(chunk)
        if len(raw) > MAX_FRAME_BYTES or (b'\n' in raw and raw.index(10) != len(raw) - 1):
            raise ValueError('invalid_frame')
    if not raw or not raw.endswith(b'\n'):
        raise ValueError('partial_frame')
    return bytes(raw)


class DarwinClock:
    """mach_continuous_time includes sleep; monotonic/uptime are not substitutes."""
    def __init__(self, library=None, platform=None):
        if (platform or sys.platform) != 'darwin':
            raise ValueError('darwin_required')
        self.library = library or ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        class Timebase(ctypes.Structure):
            _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
        base = Timebase()
        if not hasattr(self.library, 'mach_continuous_time') or self.library.mach_timebase_info(ctypes.byref(base)) != 0 or not base.numer or not base.denom:
            raise ValueError('continuous_clock_unavailable')
        self.library.mach_continuous_time.restype = ctypes.c_uint64
        self.numer, self.denom = base.numer, base.denom

    def ns(self):
        return self.library.mach_continuous_time() * self.numer // self.denom


class SntpCollector:
    def __init__(self, spawn=subprocess.Popen):
        self.spawn = spawn
        self.lock = threading.Lock()
        self.child = None
        self.stopped = False

    def __call__(self):
        with self.lock:
            if self.stopped:
                return SntpResult('', '', -1, True)
            child = self.spawn(SNTP_ARGV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=SAFE_ENV, close_fds=True)
            self.child = child
        timeout = False
        try:
            stdout, stderr = child.communicate(timeout=0.750)
        except subprocess.TimeoutExpired:
            timeout = True
            if child.poll() is None:
                child.kill()
            stdout, stderr = child.communicate()
        finally:
            with self.lock:
                self.child = None
        try:
            if len(stdout) + len(stderr) > MAX_FRAME_BYTES:
                raise ValueError('sntp_output_too_large')
            return SntpResult(stdout.decode('ascii'), stderr.decode('ascii'), child.returncode, timeout)
        except (ValueError, UnicodeError):
            return SntpResult('', '', -1, timeout)

    def stop(self):
        with self.lock:
            self.stopped = True
            if self.child is not None and self.child.poll() is None:
                self.child.kill()


def run_server(service, collector, path=SOCKET):
    if not hasattr(socket.socket, 'getpeereid'):
        raise ValueError('kernel_peer_credentials_unavailable')
    stop = threading.Event()
    workers = set()
    guard = threading.Lock()
    slots = threading.BoundedSemaphore(16)

    def shutdown(*_):
        service.stop()
        collector.stop()
        stop.set()

    def observer():
        while not stop.wait(0.100):
            try:
                service.tick()
            except Exception:
                shutdown()

    def worker(connection):
        try:
            with connection:
                connection.settimeout(1.0)
                uid, _gid = connection.getpeereid()
                if uid not in (0, service.api_uid):
                    return
                # Timer is an absolute lifetime bound, not a reset on every recv chunk.
                deadline = time.monotonic() + 1.0
                timer = threading.Timer(1.0, lambda: connection.close())
                timer.start()
                try:
                    connection.sendall(service.handle(receive_frame(connection), uid, lambda: time.monotonic() < deadline))
                finally:
                    timer.cancel()
        except (OSError, ValueError, PermissionError):
            pass
        finally:
            slots.release()
            with guard:
                workers.discard(threading.current_thread())

    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('foreign_socket')
        path.unlink()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(path))
        os.chmod(path, 0o666)
        socket_inode = path.lstat().st_ino
        listener.listen(16)
        listener.settimeout(0.100)
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, shutdown)
        thread = threading.Thread(target=observer)
        thread.start()
        try:
            while not stop.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                if not slots.acquire(False):
                    connection.close()
                    continue
                child = threading.Thread(target=worker, args=(connection,))
                with guard:
                    workers.add(child)
                child.start()
        finally:
            shutdown()
            thread.join()
            with guard:
                remaining = list(workers)
            for child in remaining:
                child.join()
            if path.exists() and path.lstat().st_ino == socket_inode:
                path.unlink()


def main():
    from installer import (load_config, check_installed, primary_binding, process_matches,
                           read_json, atomic_json)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if Path(args.config) != PREFIX / 'config.json':
        raise ValueError('fixed_config_required')
    config = load_config(Path(args.config))
    check_installed(config)
    if os.getuid() != config['producerUid'] or os.getgid() != config['producerGid']:
        raise ValueError('producer_identity_required')
    clock = DarwinClock()
    lock = acquire_state_lock(PREFIX / 'state/producer.lock', config['producerUid'])
    state_path = PREFIX / 'state/generations.json'
    generations = read_json(state_path)  # Installer creates {} only on first installation.
    def observe():
        matches = process_matches(config['primary'])
        return time.time_ns() / 1000000, clock.ns(), matches
    collector = SntpCollector()
    service = ClockService(config['apiUid'], primary_binding(config['primary']), generations,
                           observe, collector, lambda value: atomic_json(state_path, value, 0o600), str(uuid4()))
    try:
        run_server(service, collector)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('clock_attestor_unavailable')
