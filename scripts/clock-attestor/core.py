"""Clock wire v1 and injected trust state. This module performs no system I/O."""
import ipaddress
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from typing import Optional, Tuple
from uuid import UUID, uuid5


MAX_SAFE_INTEGER = 9007199254740991
MAX_FRAME_BYTES = 16384
GENERATION_KEYS = frozenset(("stepGeneration", "clearedStepGeneration",
                             "failoverGeneration", "clearedFailoverGeneration"))
PRIMARY_KEYS = frozenset(("startedAt", "address", "port"))
EVIDENCE_KEYS = GENERATION_KEYS | {"version", "nonce", "producerBootId", "observationId",
                                  "issuedAt", "offsetMs", "uncertaintyMs", "readBracketMs", "primary"}
CONTROL_KEYS = frozenset(("version", "nonce", "status", "observationId", "consecutiveSamples",
                          "stepGeneration", "failoverGeneration", "primary"))
UNAVAILABLE_REASONS = frozenset(("not_approved", "sample_unavailable", "clock_unhealthy",
                                "primary_changed", "request_invalid"))
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\Z")
_SNTP = re.compile(r"([+-][0-9]+\.[0-9]+) \+/- ([0-9]+\.[0-9]+) time\.apple\.com ([0-9A-Fa-f:.]+)\Z")


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError("finite_number_required")
    try:
        number = Decimal(str(value))
        if not number.is_finite() or not math.isfinite(float(number)):
            raise ValueError("finite_number_required")
        return number
    except (InvalidOperation, OverflowError) as error:
        raise ValueError("finite_number_required") from error


def _safe_integer(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError("safe_integer_required")


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError("canonical_uuid_required")
    try:
        if str(UUID(value)) != value:
            raise ValueError("canonical_uuid_required")
    except (ValueError, AttributeError) as error:
        raise ValueError("canonical_uuid_required") from error


def _timestamp_ms(value):
    if not isinstance(value, str) or not _TIME.fullmatch(value):
        raise ValueError("utc_millisecond_time_required")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError("utc_millisecond_time_required") from error
    delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000


def _primary(value):
    if not isinstance(value, dict) or set(value) != PRIMARY_KEYS:
        raise ValueError("primary_shape_invalid")
    _timestamp_ms(value["startedAt"])
    if value["address"] is not None:
        if not isinstance(value["address"], str):
            raise ValueError("primary_address_invalid")
        try:
            ipaddress.ip_address(value["address"])
        except (ValueError, TypeError) as error:
            raise ValueError("primary_address_invalid") from error
    port = value["port"]
    if port is not None and (type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("primary_port_invalid")


def canonical_bytes(message: dict) -> bytes:
    """Encode the restricted domain; callers validate the relevant message shape."""
    def encode(value):
        if value is None:
            return "null"
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise ValueError("string_keys_required")
            return "{" + ",".join(encode(key) + ":" + encode(value[key]) for key in sorted(value)) + "}"
        number = _number(value)
        if not number:
            return "0"
        rendered = format(number, "f")
        if "." in rendered:
            whole, fraction = rendered.split(".")
            fraction = fraction.rstrip("0")
            # Inspect digits rather than Decimal arithmetic, which has a finite context precision.
            if len(fraction) > 3:
                raise ValueError("numeric_precision_exceeded")
            rendered = whole + ("." + fraction if fraction else "")
        return rendered

    try:
        raw = (encode(message) + "\n").encode("utf-8")
    except (UnicodeError, RecursionError) as error:
        raise ValueError("invalid_encoding") from error
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError("frame_too_large")
    return raw


def _decode(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_FRAME_BYTES or not raw.endswith(b"\n"):
        raise ValueError("invalid_frame")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result or key in ("__proto__", "prototype", "constructor"):
                raise ValueError("duplicate_or_prototype_key")
            result[key] = value
        return result

    try:
        message = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_float=Decimal,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid_number")))
        if not isinstance(message, dict) or canonical_bytes(message) != raw:
            raise ValueError("noncanonical_frame")
        return message
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError("invalid_json") from error


def parse_request(raw: bytes) -> dict:
    message = _decode(raw)
    operation = message.get("op")
    expected = {"version", "op", "nonce"} | ({"observationId"} if operation == "approve" else set())
    if set(message) != expected or operation not in ("read", "status", "probe", "approve"):
        raise ValueError("request_shape_invalid")
    if type(message["version"]) is not int or message["version"] != 1:
        raise ValueError("version_invalid")
    _uuid(message["nonce"])
    if operation == "approve":
        _uuid(message["observationId"])
    return message


def parse_response(raw: bytes) -> dict:
    message = _decode(raw)
    if type(message.get("version")) is not int or message["version"] != 1:
        raise ValueError("version_invalid")
    _uuid(message.get("nonce"))
    keys = set(message)
    if keys == {"version", "nonce", "status", "reason"}:
        if (message["status"] != "unavailable" or not isinstance(message["reason"], str)
                or message["reason"] not in UNAVAILABLE_REASONS):
            raise ValueError("unavailable_invalid")
    elif keys == CONTROL_KEYS:
        if message["status"] not in ("observed", "approved"):
            raise ValueError("control_status_invalid")
        _uuid(message["observationId"])
        for key in ("consecutiveSamples", "stepGeneration", "failoverGeneration"):
            _safe_integer(message[key])
        _primary(message["primary"])
    elif keys == EVIDENCE_KEYS:
        _uuid(message["producerBootId"])
        _uuid(message["observationId"])
        _timestamp_ms(message["issuedAt"])
        for key in GENERATION_KEYS:
            _safe_integer(message[key])
        for key in ("stepGeneration", "failoverGeneration"):
            if message["cleared" + key[0].upper() + key[1:]] > message[key]:
                raise ValueError("generation_order_invalid")
        _primary(message["primary"])
        for key in ("offsetMs", "uncertaintyMs", "readBracketMs"):
            value = _number(message[key])
            if key != "offsetMs" and value < 0:
                raise ValueError("negative_uncertainty")
    else:
        raise ValueError("response_shape_invalid")
    # Match a JS consumer's number domain as well as exact decimal parsing. An apparently
    # canonical huge integer must not survive here if Number conversion would change its bytes.
    result = {key: float(value) if isinstance(value, Decimal) else value for key, value in message.items()}
    for key in ("offsetMs", "uncertaintyMs", "readBracketMs"):
        if key in result:
            result[key] = float(result[key])
    if canonical_bytes(result) != raw:
        raise ValueError("lossy_numeric_representation")
    return result


def parse_sntp(text: str) -> Tuple[float, float]:
    """Parse the observed macOS seconds-only success line, never diagnostic text."""
    if not isinstance(text, str):
        raise ValueError("sntp_format_invalid")
    match = _SNTP.fullmatch(text[:-1] if text.endswith("\n") else text)
    if match is None:
        raise ValueError("sntp_format_invalid")
    try:
        ipaddress.ip_address(match[3])
        offset = _number(Decimal(match[1]) * 1000)
        uncertainty = _number(Decimal(match[2]) * 1000)
        return float(offset), float(uncertainty)
    except (InvalidOperation, ValueError) as error:
        raise ValueError("sntp_format_invalid") from error


@dataclass(frozen=True)
class PrimaryBinding:
    started_at: str
    address: Optional[str]
    port: Optional[int]
    pid: int
    process_started_at: str

    def wire(self):
        return {"startedAt": self.started_at, "address": self.address, "port": self.port}


@dataclass(frozen=True)
class ClockSample:
    issued_at: str
    offset_ms: float
    uncertainty_ms: float
    read_bracket_ms: float


@dataclass
class ClockTrustState:
    primary: PrimaryBinding
    producer_boot_id: str
    persisted_generations: dict

    def __post_init__(self):
        _primary(self.primary.wire())
        if type(self.primary.pid) is not int or self.primary.pid <= 0:
            raise ValueError("primary_pid_invalid")
        if not isinstance(self.primary.process_started_at, str) or not self.primary.process_started_at.strip():
            raise ValueError("primary_process_start_invalid")
        _uuid(self.producer_boot_id)
        generations = self.persisted_generations
        if not isinstance(generations, dict) or (generations and set(generations) != GENERATION_KEYS):
            raise ValueError("persisted_generations_invalid")
        self.persisted_generations = dict(generations) if generations else {key: 0 for key in GENERATION_KEYS}
        for value in self.persisted_generations.values():
            _safe_integer(value)
        for key in ("stepGeneration", "failoverGeneration"):
            if self.persisted_generations["cleared" + key[0].upper() + key[1:]] > self.persisted_generations[key]:
                raise ValueError("generation_order_invalid")
        self._increment("stepGeneration")
        self._observation_revision = 0
        self._rotate_observation()
        self._last = None
        self._wall = None
        self._primary_matches = False
        self._observation_valid = False
        self._sample = None
        self._sample_ms = None
        self._last_independent_ms = None
        self._consecutive = 0
        self._approved = False
        self._latch_reason = "not_approved"
        self._sample_reason = "sample_unavailable"
        self._fatal = False

    def _increment(self, key):
        if self.persisted_generations[key] == MAX_SAFE_INTEGER:
            raise ValueError("generation_overflow")
        self.persisted_generations[key] += 1

    def _rotate_observation(self):
        self._observation_revision += 1
        # Boot identity is injected fresh by the daemon; no clock or randomness is read here.
        self._observation_id = str(uuid5(UUID(self.producer_boot_id), str(self._observation_revision)))

    def _check_generations(self):
        try:
            if set(self.persisted_generations) != GENERATION_KEYS:
                raise ValueError("generation_keys_invalid")
            for value in self.persisted_generations.values():
                _safe_integer(value)
            for key in ("stepGeneration", "failoverGeneration"):
                cleared = self.persisted_generations["cleared" + key[0].upper() + key[1:]]
                if cleared > self.persisted_generations[key] or (self._approved and cleared != self.persisted_generations[key]):
                    raise ValueError("generation_order_invalid")
            return True
        except (ValueError, TypeError, AttributeError):
            # Corrupt persisted state is never silently repaired or re-approved in this boot.
            self._invalidate("clock_unhealthy")
            self._fatal = True
            return False

    def _invalidate(self, reason, generation=None):
        self._approved = False
        self._latch_reason = reason
        self._sample = None
        self._sample_ms = None
        self._last_independent_ms = None
        self._consecutive = 0
        self._rotate_observation()
        if generation is not None:
            try:
                self._increment(generation)
            except ValueError:
                # An exhausted generation can never wrap into an apparently approved value.
                self._fatal = True

    def observe(self, wall_ms: float, continuous_ns: int, primary_matches: bool) -> None:
        if not self._check_generations():
            return
        try:
            wall = _number(wall_ms)
            if type(continuous_ns) is not int or continuous_ns < 0 or type(primary_matches) is not bool:
                raise ValueError("observation_invalid")
        except ValueError:
            self._invalidate("clock_unhealthy", "stepGeneration")
            self._last = None
            self._observation_valid = False
            return
        if not primary_matches and self._primary_matches:
            self._invalidate("primary_changed", "failoverGeneration")
        elif not primary_matches and self._latch_reason == "not_approved":
            self._invalidate("primary_changed", "failoverGeneration")
        self._primary_matches = primary_matches
        if self._last is not None:
            last_wall, last_continuous = self._last
            elapsed = Decimal(continuous_ns - last_continuous) / 1000000
            if elapsed <= 0 or elapsed > 1000 or abs(wall - last_wall - elapsed) > 10:
                self._invalidate("clock_unhealthy" if primary_matches else "primary_changed", "stepGeneration")
        self._last = (wall, continuous_ns)
        self._wall = wall
        self._observation_valid = True

    def _fresh(self, issued_ms):
        return self._wall is not None and -100 <= self._wall - issued_ms <= 1000

    def record_sample(self, sample: ClockSample) -> None:
        if not self._check_generations():
            return
        try:
            issued_ms = _timestamp_ms(sample.issued_at)
            offset = _number(sample.offset_ms)
            uncertainty = _number(sample.uncertainty_ms)
            bracket = _number(sample.read_bracket_ms)
            if uncertainty < 0 or bracket < 0:
                raise ValueError("negative_uncertainty")
            # Round the magnitude upward for admission, independently from signed wire rounding.
            # Otherwise an offset rounded toward zero could hide a real >100ms total error.
            offset_error = int((abs(offset) * 1000).to_integral_value(rounding=ROUND_CEILING))
            uncertainty_us = int((uncertainty * 1000).to_integral_value(rounding=ROUND_CEILING))
            bracket_us = int((bracket * 1000).to_integral_value(rounding=ROUND_CEILING))
            offset_us = int((offset * 1000).to_integral_value(rounding=ROUND_HALF_UP))
            if offset_error + uncertainty_us + bracket_us + 2000 > 100000:
                raise ValueError("error_budget_exceeded")
            if not self._observation_valid or not self._primary_matches or not self._fresh(issued_ms) or self._fatal:
                raise ValueError("sample_not_current")
            if self._last_independent_ms is not None and issued_ms < self._last_independent_ms:
                raise ValueError("sample_went_backwards")
        except (ValueError, AttributeError):
            self._sample = None
            self._sample_ms = None
            self._consecutive = 0
            self._sample_reason = "clock_unhealthy"
            self._rotate_observation()
            return
        normalized = ClockSample(sample.issued_at, offset_us / 1000, uncertainty_us / 1000, bracket_us / 1000)
        if issued_ms == self._last_independent_ms:
            # A cached read cannot alter the measurement or add an independent approval sample.
            return
        self._last_independent_ms = issued_ms
        self._sample = normalized
        self._sample_ms = issued_ms
        self._consecutive = min(3, self._consecutive + 1)
        self._sample_reason = "sample_unavailable"
        self._rotate_observation()

    def status(self) -> dict:
        if not self._check_generations():
            raise ValueError("persisted_generations_invalid")
        return {"status": "approved" if self._approved and not self._fatal else "observed",
                "observationId": self._observation_id, "consecutiveSamples": self._consecutive,
                "stepGeneration": self.persisted_generations["stepGeneration"],
                "failoverGeneration": self.persisted_generations["failoverGeneration"],
                "primary": self.primary.wire()}

    def approve(self, observation_id: str, peer_uid: int) -> None:
        if type(peer_uid) is not int or peer_uid != 0:
            raise PermissionError("root_required")
        if not self._check_generations():
            raise ValueError("persisted_generations_invalid")
        if (observation_id != self._observation_id or self._consecutive < 3 or self._sample is None
                or not self._primary_matches or not self._observation_valid or self._fatal
                or not self._fresh(self._sample_ms)):
            raise ValueError("observation_not_approvable")
        for key in ("stepGeneration", "failoverGeneration"):
            self.persisted_generations["cleared" + key[0].upper() + key[1:]] = self.persisted_generations[key]
        self._approved = True
        self._latch_reason = None

    def evidence(self, nonce: str) -> dict:
        _uuid(nonce)
        self._check_generations()
        reason = self._latch_reason
        if self._fatal or not self._observation_valid:
            reason = "clock_unhealthy"
        elif not self._primary_matches:
            reason = "primary_changed"
        elif not self._approved:
            reason = reason or "not_approved"
        elif self._sample is None:
            reason = self._sample_reason
        elif not self._fresh(self._sample_ms):
            reason = "sample_unavailable"
        if reason is not None:
            return {"version": 1, "nonce": nonce, "status": "unavailable", "reason": reason}
        sample = self._sample
        return {"version": 1, "nonce": nonce, "producerBootId": self.producer_boot_id,
                "observationId": self._observation_id, "issuedAt": sample.issued_at,
                "offsetMs": sample.offset_ms, "uncertaintyMs": sample.uncertainty_ms,
                "readBracketMs": sample.read_bracket_ms, **self.persisted_generations,
                "primary": self.primary.wire()}
