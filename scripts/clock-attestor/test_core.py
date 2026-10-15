"""Pure clock contract regressions; no clock, network, process, or DB access."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

from core import (ClockSample, ClockTrustState, PrimaryBinding, canonical_bytes,
                  parse_request, parse_response, parse_sntp)


BOOT = "11111111-1111-4111-8111-111111111111"
NONCE = "22222222-2222-4222-8222-222222222222"
PRIMARY = PrimaryBinding("2026-10-15T00:00:00.000Z", "127.0.0.1", 5432,
                         1234, "2026-10-15T00:00:00.000Z")
BASE = datetime(2026, 10, 15, tzinfo=timezone.utc)
WALL = 1792022400000


def iso(ms):
    return (BASE + timedelta(milliseconds=ms)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sample(ms, offset=0, uncertainty=1, bracket=0):
    return ClockSample(iso(ms), offset, uncertainty, bracket)


def state():
    result = ClockTrustState(PRIMARY, BOOT, {})
    result.observe(WALL, 0, True)
    return result


def collect(result, first=100, count=3):
    for ms in range(first, first + count * 100, 100):
        result.observe(WALL + ms, ms * 1000000, True)
        result.record_sample(sample(ms))


def approved():
    result = state()
    collect(result)
    result.approve(result.status()["observationId"], 0)
    return result


class SntpTests(unittest.TestCase):
    def test_seconds_are_converted_to_signed_milliseconds(self):
        self.assertEqual(parse_sntp("+0.058639 +/- 0.005864 time.apple.com 17.253.14.253\n"), (58.639, 5.864))
        self.assertEqual(parse_sntp("-0.058639 +/- 0.005864 time.apple.com 17.253.14.253"), (-58.639, 5.864))

    def test_rejects_missing_or_ambiguous_results_units_and_nonfinite(self):
        for text in ("", "+0.1 ms +/- 0.01 ms", "+0.1 +/- -0.01 time.apple.com",
                     "NaN +/- 0.01 time.apple.com", "+0.1 +/- Infinity time.apple.com",
                     "+0.1 +/- 0.01 time.apple.com\n+0.2 +/- 0.01 time.apple.com",
                     "warning\n+0.1 +/- 0.01 time.apple.com", "+0.1 +/- 0.01 seconds",
                     "+1e-3 +/- 0.01 time.apple.com", "+0.1 +/- 0.01 +0.2 +/- 0.01"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_sntp(text)


class TrustTests(unittest.TestCase):
    def test_corrupt_runtime_generations_and_overflow_cannot_issue_evidence(self):
        for corruption in ({"stepGeneration": True}, {"clearedStepGeneration": 2},
                           {"stepGeneration": 2}, {"unexpected": 0}):
            with self.subTest(corruption=corruption):
                result = approved()
                observation_id = result.status()["observationId"]
                result.persisted_generations.update(corruption)
                self.assertEqual(result.evidence(NONCE).get("reason"), "clock_unhealthy")
                with self.assertRaises(ValueError):
                    result.approve(observation_id, 0)
        result = ClockTrustState(PRIMARY, BOOT, {"stepGeneration": 9007199254740990,
                                                "clearedStepGeneration": 0,
                                                "failoverGeneration": 0, "clearedFailoverGeneration": 0})
        result.observe(WALL, 0, True)
        collect(result)
        result.approve(result.status()["observationId"], 0)
        result.observe(WALL + 411, 400000000, True)
        self.assertEqual(result.evidence(NONCE)["reason"], "clock_unhealthy")
        self.assertEqual(result.status()["stepGeneration"], 9007199254740991)

    def test_step_recovery_requires_three_new_samples_and_fresh_exact_approval(self):
        result = approved()
        result.observe(WALL + 411, 400000000, True)
        result.record_sample(sample(411))
        self.assertEqual(result.status()["consecutiveSamples"], 1)
        result.observe(WALL + 511, 500000000, True)
        result.record_sample(sample(511))
        with self.assertRaises(ValueError):
            result.approve(result.status()["observationId"], 0)
        result.observe(WALL + 611, 600000000, True)
        result.record_sample(sample(611))
        result.approve(result.status()["observationId"], 0)
        self.assertIn("issuedAt", result.evidence(NONCE))

    def test_startup_three_samples_and_exact_root_approval_are_all_required(self):
        result = state()
        self.assertEqual(result.evidence(NONCE)["reason"], "not_approved")
        collect(result, count=2)
        with self.assertRaises(ValueError):
            result.approve(result.status()["observationId"], 0)
        old = result.status()["observationId"]
        collect(result, first=300, count=1)
        with self.assertRaises(ValueError):
            result.approve(old, 0)
        with self.assertRaises(PermissionError):
            result.approve(result.status()["observationId"], 501)
        result.approve(result.status()["observationId"], 0)
        self.assertEqual(result.status()["status"], "approved")
        evidence = result.evidence(NONCE)
        self.assertEqual(evidence["stepGeneration"], evidence["clearedStepGeneration"])
        self.assertEqual(evidence["primary"], {"startedAt": PRIMARY.started_at, "address": "127.0.0.1", "port": 5432})
        self.assertNotIn("pid", evidence["primary"])

    def test_cached_sample_never_gets_a_new_issue_time_or_counts_as_independent(self):
        result = state()
        collect(result, count=1)
        result.record_sample(sample(100))
        self.assertEqual(result.status()["consecutiveSamples"], 1)
        collect(result, first=200, count=2)
        result.approve(result.status()["observationId"], 0)
        before = result.evidence(NONCE)
        result.observe(WALL + 400, 400000000, True)
        after = result.evidence("33333333-3333-4333-8333-333333333333")
        self.assertEqual(before["issuedAt"], "2026-10-15T00:00:00.300Z")
        self.assertEqual(after["issuedAt"], before["issuedAt"])

    def test_error_budget_exact_boundary_and_signed_offset(self):
        for offset, uncertainty, bracket, healthy in ((-90, 7, 1, True), (90, 7.001, 1, False),
                                                     (90.0004, 7, 1, False), (0, -1, 0, False),
                                                     (0, float("nan"), 0, False), (0, 1, float("inf"), False)):
            with self.subTest(offset=offset, uncertainty=uncertainty, bracket=bracket):
                result = approved()
                result.observe(WALL + 400, 400000000, True)
                result.record_sample(sample(400, offset, uncertainty, bracket))
                response = result.evidence(NONCE)
                self.assertEqual("issuedAt" in response, healthy)
                if healthy:
                    self.assertEqual(response["offsetMs"], -90)

    def test_sample_age_exact_one_second_and_future_exact_100ms(self):
        for issued, healthy in ((300, True), (299, False), (1400, True), (1401, False)):
            with self.subTest(issued=issued):
                result = approved()
                for ms in range(400, 1301, 100):
                    result.observe(WALL + ms, ms * 1000000, True)
                result.record_sample(sample(issued))
                self.assertEqual("issuedAt" in result.evidence(NONCE), healthy)

    def test_cached_sample_expires_without_reissuing_or_changing_generation(self):
        result = approved()
        generation = result.evidence(NONCE)["stepGeneration"]
        for ms in range(400, 1301, 100):
            result.observe(WALL + ms, ms * 1000000, True)
        self.assertIn("issuedAt", result.evidence(NONCE))
        result.observe(WALL + 1301, 1301000000, True)
        self.assertEqual(result.evidence(NONCE)["reason"], "sample_unavailable")
        self.assertEqual(result.status()["stepGeneration"], generation)

    def test_gap_and_step_boundaries_latch_until_new_samples_and_approval(self):
        for wall_delta, continuous_delta, healthy in ((1000, 1000, True), (1001, 1001, False),
                                                      (110, 100, True), (111, 100, False),
                                                      (90, 100, True), (89, 100, False)):
            with self.subTest(wall=wall_delta, continuous=continuous_delta):
                result = approved()
                old = result.status()["observationId"]
                result.observe(WALL + 300 + wall_delta, (300 + continuous_delta) * 1000000, True)
                self.assertEqual(result.status()["status"] == "approved", healthy)
                if not healthy:
                    self.assertEqual(result.evidence(NONCE)["reason"], "clock_unhealthy")
                    self.assertEqual(result.status()["consecutiveSamples"], 0)
                    with self.assertRaises(ValueError):
                        result.approve(old, 0)

    def test_primary_mismatch_latches_and_requires_three_new_samples(self):
        result = approved()
        old = result.status()["observationId"]
        result.observe(WALL + 400, 400000000, False)
        self.assertEqual(result.evidence(NONCE)["reason"], "primary_changed")
        self.assertEqual(result.status()["failoverGeneration"], 1)
        result.observe(WALL + 500, 500000000, False)
        self.assertEqual(result.status()["failoverGeneration"], 1)
        with self.assertRaises(ValueError):
            result.approve(old, 0)
        collect(result, first=600)
        self.assertNotIn("issuedAt", result.evidence(NONCE))
        result.approve(result.status()["observationId"], 0)
        self.assertEqual(result.evidence(NONCE)["clearedFailoverGeneration"], 1)

    def test_restart_preserves_generations_but_never_approval(self):
        result = approved()
        evidence = result.evidence(NONCE)
        persisted = {key: evidence[key] for key in ("stepGeneration", "clearedStepGeneration", "failoverGeneration", "clearedFailoverGeneration")}
        restarted = ClockTrustState(PRIMARY, "33333333-3333-4333-8333-333333333333", persisted)
        restarted.observe(WALL + 400, 400000000, True)
        self.assertEqual(restarted.evidence(NONCE)["reason"], "not_approved")
        self.assertEqual(restarted.status()["stepGeneration"], evidence["stepGeneration"] + 1)

    def test_invalid_persisted_generations_and_noncontinuous_observation_deny(self):
        for persisted in ({"stepGeneration": 1}, {"stepGeneration": -1}, {"bad": 1},
                          {"stepGeneration": 9007199254740991, "clearedStepGeneration": 0,
                           "failoverGeneration": 0, "clearedFailoverGeneration": 0}):
            with self.subTest(persisted=persisted), self.assertRaises(ValueError):
                ClockTrustState(PRIMARY, BOOT, persisted)
        for wall, counter in ((float("nan"), 400000000), (WALL + 400, -1), (WALL + 400, 300000000)):
            with self.subTest(wall=wall, counter=counter):
                result = approved()
                result.observe(wall, counter, True)
                self.assertNotIn("issuedAt", result.evidence(NONCE))


class WireTests(unittest.TestCase):
    def test_shared_normalization_examples_preserve_admission_and_signed_values(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures/evidence-v1.json").read_text())
        for case in fixtures["normalization"]:
            with self.subTest(case=case["name"]):
                result = approved()
                result.observe(WALL + 400, 400000000, True)
                values = case["input"]
                result.record_sample(sample(400, values["offsetMs"], values["uncertaintyMs"], values["readBracketMs"]))
                response = result.evidence(NONCE)
                self.assertEqual("issuedAt" in response, case["admitted"])
                if case["admitted"]:
                    self.assertEqual({key: response[key] for key in case["expected"]}, case["expected"])

    def test_nested_unknown_fields_wrong_types_and_generation_order_are_rejected(self):
        response = json.loads(canonical_bytes(approved().evidence(NONCE)))
        for changed in (dict(response, primary=dict(response["primary"], pid=1234)),
                        dict(response, primary=dict(response["primary"], address=1234)),
                        dict(response, primary=dict(response["primary"], port=True)),
                        dict(response, clearedStepGeneration=2), dict(response, stepGeneration=1.5),
                        {"version": 1, "nonce": NONCE, "status": "unavailable", "reason": []},
                        {"version": 1, "nonce": NONCE, "status": "unavailable", "reason": {}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                # The malformed collection is intentional raw input, outside the canonical encoder domain.
                raw = (json.dumps(changed, sort_keys=True, separators=(",", ":")) + "\n").encode()
                parse_response(raw)
        for current, cleared in ((True, 0), (1.5, 0), (1, 2), (1, True), (9007199254740992, 0)):
            with self.subTest(current=current, cleared=cleared), self.assertRaises(ValueError):
                ClockTrustState(PRIMARY, BOOT, {"stepGeneration": current, "clearedStepGeneration": cleared,
                                               "failoverGeneration": 0, "clearedFailoverGeneration": 0})

    def test_fixtures_are_canonical_and_have_exact_shapes(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures/evidence-v1.json").read_text())
        for case in fixtures["valid"]:
            with self.subTest(case=case["name"]):
                raw = case["wire"].encode("utf-8")
                parser = parse_request if case["direction"] == "request" else parse_response
                self.assertEqual(canonical_bytes(parser(raw)), raw)
        for case in fixtures["invalid"]:
            with self.subTest(case=case["name"]), self.assertRaises(ValueError):
                parser = parse_request if case["direction"] == "request" else parse_response
                parser(case["wire"].encode("utf-8"))

    def test_duplicate_unknown_noncanonical_and_invalid_values_are_rejected(self):
        valid = canonical_bytes({"version": 1, "op": "read", "nonce": NONCE})
        self.assertEqual(parse_request(valid)["nonce"], NONCE)
        for raw in (valid.rstrip(b"\n"), valid + b"\n", b" " + valid,
                    valid.replace(b'"version":1', b'"version":1.0'),
                    valid.replace(b'"version":1', b'"version":1,"version":1'),
                    valid.replace(b'"version":1', b'"version":1,"unknown":0'),
                    valid.replace(NONCE.encode(), NONCE.upper().encode().replace(b"2222", b"ABCD", 1)),
                    valid.replace(b'"version":1', b'"version":true'),
                    valid.replace(b'"op":"read"', b'"op":"approve"')):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_request(raw)
        response = approved().evidence(NONCE)
        for field, value in (("uncertaintyMs", -1), ("readBracketMs", -1), ("offsetMs", float("inf")),
                             ("stepGeneration", 9007199254740992), ("issuedAt", "2026-10-15T00:00:00Z")):
            changed = dict(response, **{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                parse_response(canonical_bytes(changed))

    def test_fractional_rounding_is_conservative_and_canonical(self):
        result = approved()
        result.observe(WALL + 400, 400000000, True)
        result.record_sample(sample(400, -0.0004, 0.0001, 0.0001))
        response = result.evidence(NONCE)
        self.assertEqual((response["offsetMs"], response["uncertaintyMs"], response["readBracketMs"]), (0, 0.001, 0.001))
        raw = canonical_bytes(response)
        self.assertIn(b'"offsetMs":0,', raw)
        for old, new in ((b'"offsetMs":0,', b'"offsetMs":-0,'),
                         (b'"offsetMs":0,', b'"offsetMs":0.0,'),
                         (b'"uncertaintyMs":0.001,', b'"uncertaintyMs":1e-3,'),
                         (b'"uncertaintyMs":0.001,', b'"uncertaintyMs":0.0010,')):
            with self.subTest(new=new), self.assertRaises(ValueError):
                parse_response(raw.replace(old, new))


if __name__ == "__main__":
    unittest.main()
