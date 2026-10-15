"""Injected clocks/children only: this suite never queries SNTP or a real DB."""
import unittest
import importlib.util
import socket
import subprocess
import threading
import tempfile
import os
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from core import ClockTrustState, PrimaryBinding, canonical_bytes, parse_response
from daemon import ClockService, SntpResult, SntpCollector, DarwinClock, receive_frame, SNTP_ARGV, acquire_state_lock

spec = importlib.util.spec_from_file_location('clock_operator', Path(__file__).with_name('operator.py'))
clock_operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clock_operator)


PRIMARY = PrimaryBinding('2026-10-15T00:00:00.000Z', '127.0.0.1', 5432, 123, 'Thu Oct 15 09:00:00 2026')
LINE = '+0.062763 +/- 0.006118 time.apple.com 17.253.114.35\n'


class Environment:
    def __init__(self):
        self.wall = 1792022400000
        self.ns = 1000000000
        self.matches = True
        self.saved = []
        self.calls = 0
        self.result = SntpResult(LINE, '', 0, False)
        self.duration = 20
        self.after = lambda: None

    def observe(self):
        self.wall += 1
        self.ns += 1000000
        return self.wall, self.ns, self.matches

    def collect(self):
        self.calls += 1
        self.wall += self.duration
        self.ns += self.duration * 1000000
        self.after()
        return self.result

    def persist(self, values):
        self.saved.append(dict(values))


class SocketChunks:
    def __init__(self, chunks):
        self.chunks = list(chunks)
    def recv(self, size):
        return self.chunks.pop(0) if self.chunks else b''


class DaemonTests(unittest.TestCase):
    def setUp(self):
        self.env = Environment()
        self.service = ClockService(501, PRIMARY, {}, self.env.observe,
                                    self.env.collect, self.env.persist, str(uuid4()))

    def request(self, op, uid=0, **fields):
        raw = canonical_bytes(dict(version=1, op=op, nonce=str(uuid4()), **fields))
        return parse_response(self.service.handle(raw, uid))

    def approve(self):
        for _ in range(3):
            status = self.request('probe')
            self.assertEqual(status['status'], 'observed')
        return self.request('approve', observationId=status['observationId'])

    def test_api_can_only_read_root_can_only_control_and_unknown_peer_is_denied(self):
        for uid, op in [(501, 'probe'), (501, 'status'), (501, 'approve'), (502, 'read'), (0, 'read')]:
            with self.subTest(uid=uid, op=op), self.assertRaises(PermissionError):
                self.request(op, uid, **({'observationId': str(uuid4())} if op == 'approve' else {}))
        self.assertEqual(self.env.calls, 0)

    def test_three_independent_samples_then_exact_approval_and_cached_issue_time(self):
        self.assertEqual(self.approve()['status'], 'approved')
        first = self.request('read', 501)
        second = self.request('read', 501)
        self.assertEqual(first['issuedAt'], second['issuedAt'])
        self.assertEqual(first['offsetMs'], 62.763)
        self.assertEqual(self.env.calls, 3)
        self.assertEqual(set(self.env.saved[-1]), {'stepGeneration', 'clearedStepGeneration', 'failoverGeneration', 'clearedFailoverGeneration'})
        self.assertEqual(self.env.saved[-1]['clearedStepGeneration'], 1)

    def test_fresh_decision_observation_detects_sleep_step_and_primary_change(self):
        for mutation in ('sleep', 'step', 'primary'):
            self.setUp()
            self.approve()
            if mutation == 'sleep':
                self.env.wall += 2000
                self.env.ns += 2000000000
            elif mutation == 'step':
                self.env.wall += 11
            else:
                self.env.matches = False
            result = self.request('read', 501)
            self.assertEqual(result['status'], 'unavailable', mutation)

    def test_restart_preserves_generations_but_requires_fresh_approval(self):
        self.approve()
        self.service = ClockService(501, PRIMARY, self.env.saved[-1], self.env.observe,
                                    self.env.collect, self.env.persist, str(uuid4()))
        self.assertEqual(self.request('read', 501)['status'], 'unavailable')
        self.assertEqual(self.env.saved[-1]['stepGeneration'], 2)

    def test_timeout_stderr_nonzero_ambiguous_late_and_stopped_never_count(self):
        for result, duration, stop in [(SntpResult(LINE, '', 0, True), 20, False),
                                       (SntpResult(LINE, 'Timeout', 0, False), 20, False),
                                       (SntpResult(LINE, '', 1, False), 20, False),
                                       (SntpResult(LINE + LINE, '', 0, False), 20, False),
                                       (SntpResult(LINE, '', 0, False), 751, False),
                                       (SntpResult(LINE, '', 0, False), 20, True)]:
            self.setUp()
            self.env.result, self.env.duration = result, duration
            if stop:
                self.env.after = self.service.stop
            response = self.request('probe')
            self.assertEqual(response['status'], 'unavailable')
            self.assertEqual(self.service.state.status()['consecutiveSamples'], 0)

    def test_status_does_not_collect_and_stale_approval_does_not_retry(self):
        first = self.request('probe')
        self.assertEqual(first['status'], 'observed')
        self.request('probe')
        self.request('probe')
        self.assertEqual(self.request('approve', observationId=first['observationId'])['status'], 'unavailable')
        self.request('status')
        self.assertEqual(self.env.calls, 3)

    def test_invalid_frame_rejected_before_sampling(self):
        for raw in [b'{}\n', b'{}', b'x' * 16385, b'{"nonce":"a","nonce":"b"}\n',
                    canonical_bytes(dict(version=1, op='read', nonce='bad')),
                    canonical_bytes(dict(version=1, op='read', nonce=str(uuid4()), offset=0))]:
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                self.service.handle(raw, 501)
        self.assertEqual(self.env.calls, 0)

    def test_framing_requires_eof_no_trailing_data_partial_or_oversize(self):
        self.assertEqual(receive_frame(SocketChunks([b'{', b'}\n', b''])), b'{}\n')
        for chunks in [[b'{}'], [b'{}\n', b'junk'], [b'x' * 16385], [b'{}\n{}\n']]:
            with self.subTest(chunks=chunks), self.assertRaises(ValueError):
                receive_frame(SocketChunks(chunks))

    def test_inflight_is_shared_while_observer_keeps_running(self):
        entered, finish, waiting = threading.Event(), threading.Event(), threading.Event()
        original_wait = self.service.condition.wait_for
        def wait_for(predicate, timeout):
            waiting.set()
            return original_wait(predicate, timeout)
        self.service.condition.wait_for = wait_for
        def collect():
            self.env.calls += 1
            entered.set()
            self.assertTrue(finish.wait(1))
            return self.env.result
        self.service.collect = collect
        replies = []
        first = threading.Thread(target=lambda: replies.append(self.request('probe')))
        second = threading.Thread(target=lambda: replies.append(self.request('probe')))
        first.start()
        try:
            self.assertTrue(entered.wait(1))
            second.start()
            self.assertTrue(waiting.wait(1))
            self.service.tick()
        finally:
            finish.set()
            first.join(1)
            second.join(1)
        self.assertEqual(self.env.calls, 1)
        self.assertEqual([reply['consecutiveSamples'] for reply in replies], [1, 1])
        self.assertEqual(replies[0]['observationId'], replies[1]['observationId'])

    def test_sntp_owns_fixed_child_kills_and_drains_timeout_and_does_not_spawn_after_stop(self):
        calls = []
        class Child:
            returncode = None
            first = True
            killed = False
            def communicate(self, timeout=None):
                if self.first:
                    self.first = False
                    raise subprocess.TimeoutExpired(SNTP_ARGV, timeout)
                self.returncode = -9
                return LINE.encode(), b''
            def poll(self):
                return self.returncode
            def kill(self):
                self.killed = True
        child = Child()
        def spawn(argv, **kwargs):
            calls.append((argv, kwargs))
            return child
        collector = SntpCollector(spawn)
        result = collector()
        self.assertTrue(result.timed_out)
        self.assertTrue(child.killed)
        self.assertEqual(result.returncode, -9)
        self.assertEqual(calls[0][0], ('/usr/bin/sntp', '-t', '1', 'time.apple.com'))
        self.assertNotIn('shell', calls[0][1])
        self.assertNotIn('PYTHONPATH', calls[0][1]['env'])
        collector.stop()
        self.assertTrue(collector().timed_out)
        self.assertEqual(len(calls), 1)

    def test_continuous_clock_rejects_unsupported_platform_and_missing_symbol(self):
        with self.assertRaises(ValueError):
            DarwinClock(platform='linux')
        with self.assertRaises(ValueError):
            DarwinClock(library=object(), platform='darwin')

    def test_maximum_read_bracket_is_preserved_when_wall_delta_returns_to_origin(self):
        def collect():
            self.env.wall += 8
            self.service.tick()
            self.env.wall -= 8
            return self.env.collect()
        self.service.collect = collect
        self.approve()
        reply = self.request('read', 501)
        self.assertEqual(reply['readBracketMs'], 8)

    def test_single_producer_lock_survives_state_atomic_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'producer.lock'
            descriptor = acquire_state_lock(path, os.getuid())
            self.assertIsInstance(descriptor, int)
            try:
                with self.assertRaises((OSError, ValueError)):
                    acquire_state_lock(path, os.getuid())
            finally:
                os.close(descriptor)
            descriptor = acquire_state_lock(path, os.getuid())
            os.close(descriptor)

    def test_expired_ipc_cannot_approve_or_record_late_probe(self):
        for _ in range(3):
            status = self.request('probe')
        raw = canonical_bytes(dict(version=1, op='approve', nonce=str(uuid4()), observationId=status['observationId']))
        reply = parse_response(self.service.handle(raw, 0, request_valid=lambda: False))
        self.assertEqual(reply['status'], 'unavailable')
        self.assertEqual(self.service.state.status()['status'], 'observed')
        self.setUp()
        live = [True]
        self.env.after = lambda: live.__setitem__(0, False)
        raw = canonical_bytes(dict(version=1, op='probe', nonce=str(uuid4())))
        reply = parse_response(self.service.handle(raw, 0, request_valid=lambda: live[0]))
        self.assertEqual(reply['status'], 'unavailable')
        self.assertEqual(self.service.state.status()['consecutiveSamples'], 0)

    def test_failed_reads_are_coalesced_and_throttled_without_synthetic_health(self):
        self.env.result = SntpResult('', 'Timeout', 1, True)
        for _ in range(5):
            self.assertEqual(self.request('read', 501)['status'], 'unavailable')
        self.assertEqual(self.env.calls, 1)

    def test_operator_half_closes_and_validates_peer_nonce_and_full_response(self):
        class Connection(SocketChunks):
            def __init__(self, bad_peer=False, bad_nonce=False):
                super().__init__([])
                self.events = []
                self.bad_peer, self.bad_nonce = bad_peer, bad_nonce
            def settimeout(self, value):
                pass
            def getpeereid(self):
                return (999 if self.bad_peer else 502, 502)
            def sendall(self, raw):
                from core import parse_request
                request = parse_request(raw)
                self.events.append('send')
                nonce = str(uuid4()) if self.bad_nonce else request['nonce']
                self.chunks = [canonical_bytes(dict(version=1, nonce=nonce, status='unavailable', reason='not_approved')), b'']
            def shutdown(self, direction):
                self.events.append(direction)
            def close(self):
                self.events.append('close')
        connection = Connection()
        with patch.object(clock_operator.os, 'geteuid', return_value=0):
            reply = clock_operator.exchange('status', connect=lambda: connection, producer_uid=502)
            self.assertEqual(reply.get('status'), 'unavailable')
            self.assertEqual(connection.events, ['send', socket.SHUT_WR, 'close'])
            for bad in (Connection(bad_peer=True), Connection(bad_nonce=True)):
                with self.assertRaises((ValueError, PermissionError)):
                    clock_operator.exchange('status', connect=lambda: bad, producer_uid=502)
        with patch.object(clock_operator.os, 'geteuid', return_value=501), self.assertRaises(PermissionError):
            clock_operator.exchange('probe', connect=lambda: connection, producer_uid=502)


if __name__ == '__main__':
    unittest.main()
