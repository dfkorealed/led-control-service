"""Own one nonroot CI Jest UID and reap its detached fixtures before cleanup.

This entry point assumes an approved GitHub-hosted checkout with sudo permission.
It is CI lifecycle isolation, not a privilege boundary for malicious checkout code.
Privileged commands use fixed paths; the caller's environment only reaches Jest.
"""
import argparse
import ctypes
import grp
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

PROFILE = "isolated-linux-ci"
MAX_FRAME_BYTES = 1024 * 1024


def validate_bootstrap(frame, api):
    if not isinstance(frame, dict) or frame.get("version") != 1 or frame.get("args") != []:
        raise RuntimeError("API CI profile requires a versioned full suite invocation")
    env = frame.get("env")
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) and "\0" not in k + v for k, v in env.items()):
        raise RuntimeError("invalid API CI environment")
    expected = {"CI": "true", "GITHUB_ACTIONS": "true", "GITHUB_JOB": "unit", "RUNNER_OS": "Linux", "LED_API_UNIT_PROFILE": PROFILE,
                "GITHUB_WORKSPACE": str(api.parent.parent)}
    if any(env.get(key) != value for key, value in expected.items()):
        raise RuntimeError("API CI profile/workspace mismatch")
    return env.copy()


def directory_identity(path, owner):
    entry = path.lstat()
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != owner:
        raise RuntimeError("owned directory identity mismatch: " + str(path))
    return (entry.st_dev, entry.st_ino, entry.st_uid)


def verify_directory(path, identity):
    if directory_identity(path, identity[2]) != identity:
        raise RuntimeError("owned directory inode changed: " + str(path))


def snapshot_workspace(source, destination, uid, gid):
    """Copy prepared workspace inodes without changing the runner's home/checkout.

    A hosted runner's home can deny traversal to the fresh UID. Keep relative
    pnpm/workspace links and generated outputs in an owned mirror instead. Never
    hardlink source files, or let a copied link escape back into the original.
    """
    source = source.resolve(strict=True)
    excluded = {".git", ".local", ".worktrees"}

    def validate_links(directory, names):
        ignored = excluded.intersection(names) if Path(directory) == source else set()
        for name in set(names) - ignored:
            entry = Path(directory) / name
            if not entry.is_symlink():
                continue
            if entry.readlink().is_absolute():
                raise RuntimeError("workspace contains an absolute symlink: " + str(entry))
            target = entry.resolve(strict=True)
            relative = target.relative_to(source) if target.is_relative_to(source) else None
            if relative is None or (relative.parts and relative.parts[0] in excluded):
                raise RuntimeError("workspace symlink escapes the copied source: " + str(entry))
        return ignored

    shutil.copytree(source, destination, symlinks=True, ignore=validate_links)
    def fail_walk(error):
        raise error

    # Source resolution alone can hide an excluded intermediate alias: a link
    # through .local may resolve into packages in the source but break after
    # copying. Check the complete copied graph before metadata changes or Jest
    # startup; strict resolution also rejects missing targets and link cycles.
    mirror = destination.resolve(strict=True)
    for directory, dirs, files in os.walk(mirror, followlinks=False, onerror=fail_walk):
        for entry in [Path(directory) / name for name in dirs + files]:
            if not entry.is_symlink():
                continue
            if entry.readlink().is_absolute():
                raise RuntimeError("copied workspace contains an absolute symlink: " + str(entry))
            if not entry.resolve(strict=True).is_relative_to(mirror):
                raise RuntimeError("workspace symlink escapes the copied mirror: " + str(entry))

    # Only newly copied inodes change owner/mode. Owner access also handles
    # original runner-only 0700 directories and 0600 generated files.
    for directory, dirs, files in os.walk(destination, followlinks=False, onerror=fail_walk):
        for entry in [Path(directory)] + [Path(directory) / name for name in dirs + files]:
            os.chown(entry, uid, gid, follow_symlinks=False)
            mode = entry.lstat().st_mode
            if not stat.S_ISLNK(mode):
                access = stat.S_IRWXU if stat.S_ISDIR(mode) else stat.S_IRUSR
                os.chmod(entry, stat.S_IMODE(mode) | access)
    return destination


def ci_jest_environment(env, account):
    # Prisma 6 CLI usage/update telemetry forks an unreferenced checkpoint child.
    # Disable that test-tool side effect only in this CI profile, so genuine
    # unexpected fixture children still fail the successful-Jest lifecycle gate.
    return {**env, "CHECKPOINT_DISABLE": "1", "HOME": str(account.home),
            "TMPDIR": str(account.tmp), "TMP": str(account.tmp), "TEMP": str(account.tmp),
            "XDG_CACHE_HOME": str(account.cache)}


class FixtureDirectories:
    """Account only new, exactly owned PG fixture directories beneath /tmp.

    The DB helper deliberately ignores TMPDIR. Keep every baseline pathname,
    including replacements, and never follow a candidate symlink. A directory
    FD anchors both observations and Python's symlink-resistant recursive removal.
    """
    def __init__(self, root=Path("/tmp")):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError("symlink-resistant fixture removal is unavailable")
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.baseline = set(os.listdir(self.fd))
        except BaseException:
            os.close(self.fd)
            raise
        self.captured = {}

    def observe(self, uid):
        for name in os.listdir(self.fd):
            if name in self.baseline or not name.startswith("gateway-watermark-"):
                continue
            try:
                entry = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:  # Normal helper cleanup can finish during a scan.
                continue
            identity = (entry.st_dev, entry.st_ino, entry.st_uid)
            if name in self.captured and identity != self.captured[name]:
                raise RuntimeError("PG fixture directory identity changed: " + name)
            if stat.S_ISDIR(entry.st_mode) and entry.st_uid == uid:
                self.captured[name] = identity

    def remove(self):
        for name, identity in self.captured.items():
            try:
                entry = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(entry.st_mode) or (entry.st_dev, entry.st_ino, entry.st_uid) != identity:
                raise RuntimeError("PG fixture directory identity changed before removal: " + name)
            shutil.rmtree(name, dir_fd=self.fd)
        self.captured.clear()

    def close(self):
        os.close(self.fd)


class ControlPipe:
    def __init__(self, fd):
        self.fd = fd
        self.buffer = b""
        self.eof = False

    def _read(self):
        chunk = os.read(self.fd, 65536)
        if not chunk:
            self.eof = True
        self.buffer += chunk
        if len(self.buffer) > MAX_FRAME_BYTES:
            raise RuntimeError("API supervisor IPC frame exceeds limit")

    def bootstrap(self):
        while b"\n" not in self.buffer:
            self._read()
            if self.eof:
                raise RuntimeError("API supervisor IPC EOF before bootstrap")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def poll(self):
        if select.select([self.fd], [], [], 0)[0] and not self.eof:
            self._read()
        messages = []
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            message = json.loads(line)
            if message not in ({"signal": "SIGINT"}, {"signal": "SIGTERM"}):
                raise RuntimeError("invalid API supervisor control message")
            messages.append(message["signal"])
        return messages


def owned_tasks(uid):
    result = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
            if int(fields["Uid"].split()[0]) != uid:
                continue
            # comm can contain spaces or ')'; the last ')' precedes fixed stat fields.
            process_stat = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            result.append({"pid": int(entry.name), "start": process_stat[19],
                           "state": process_stat[0], "parent": int(process_stat[1]),
                           "threads": int(fields["Threads"]), "uid": uid})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def signal_tasks(uid, requested):
    for entry in owned_tasks(uid):
        # Recheck UID and start time immediately before signaling a numeric PID.
        current = next((p for p in owned_tasks(uid) if p["pid"] == entry["pid"]), None)
        if current and current["start"] == entry["start"]:
            try:
                os.kill(entry["pid"], requested)
            except ProcessLookupError:
                pass


def enable_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    active = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(active), 0, 0, 0) != 0 or active.value != 1:
        raise RuntimeError("API supervisor subreaper was not enabled")


def reap_adopted(main_pid):
    count = 0
    children = Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
    for raw in children:
        pid = int(raw)
        if pid == main_pid:
            continue
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                count += 1
        except ChildProcessError:
            pass
    return count


class OwnedAccount:
    def __init__(self):
        self.name = "led-api-" + uuid.uuid4().hex[:16]
        self.uid = None
        self.owns_uid = False
        self.gid = None
        self.root = None
        self.identities = {}
        self.fixtures = None
        self.root_removed = False

    def create(self):
        for lookup in (pwd.getpwnam, grp.getgrnam):
            try:
                lookup(self.name)
            except KeyError:
                continue
            raise RuntimeError("API fixture account collision")
        # Baseline capture must succeed before any Jest process or UID is created.
        self.fixtures = FixtureDirectories()
        self.root = Path(tempfile.mkdtemp(prefix="led-api-unit-", dir="/tmp"))
        self.identities[self.root] = directory_identity(self.root, 0)
        os.chmod(self.root, 0o711)
        home = self.root / "home"
        self.home, self.tmp, self.cache = home, self.root / "tmp", self.root / "cache"
        subprocess.run(["/usr/sbin/useradd", "--user-group", "--no-create-home", "--home-dir", str(home), "--shell", "/usr/sbin/nologin", self.name], check=True)
        account = pwd.getpwnam(self.name)
        self.uid, self.gid = account.pw_uid, account.pw_gid
        if self.uid == 0 or owned_tasks(self.uid):
            raise RuntimeError("API fixture UID is not fresh and nonroot")
        self.owns_uid = True
        for directory in (self.home, self.tmp, self.cache):
            directory.mkdir(mode=0o700)
            os.chown(directory, self.uid, self.gid)
            self.identities[directory] = directory_identity(directory, self.uid)
        self.verify_account()

    def verify_account(self):
        account = pwd.getpwnam(self.name)
        group = grp.getgrnam(self.name)
        if (account.pw_uid, account.pw_gid, account.pw_dir, group.gr_gid, group.gr_mem) != (self.uid, self.gid, str(self.home), self.gid, []):
            raise RuntimeError("API fixture account identity changed")

    def command(self, node, jest):
        return ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
                "--reuid=" + str(self.uid), "--regid=" + str(self.gid), "--clear-groups", str(node), str(jest),
                "--runInBand", "--cacheDirectory", str(self.cache)]

    def cleanup(self):
        if self.uid is not None and not self.owns_uid:
            raise RuntimeError("refusing cleanup of a non-owned collision UID")
        if self.uid is not None:
            if owned_tasks(self.uid):
                raise RuntimeError("API fixture UID still has processes at account cleanup")
            self.verify_account()
        for directory, identity in self.identities.items():
            verify_directory(directory, identity)
        if self.fixtures is not None:
            if self.owns_uid:
                self.fixtures.observe(self.uid)
            self.fixtures.remove()
        # Delete all owned directories before releasing the UID for possible reuse.
        if self.root is not None and not self.root_removed:
            parent_fd = os.open(self.root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                verify_directory(self.root, self.identities[self.root])
                shutil.rmtree(self.root.name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            self.root_removed = True
            self.identities.clear()
        if self.root is not None and os.path.lexists(self.root):
            raise RuntimeError("API fixture temporary cleanup incomplete")
        if self.uid is not None:
            subprocess.run(["/usr/sbin/userdel", self.name], check=True)
            try:
                group = grp.getgrnam(self.name)
            except KeyError:
                group = None
            if group is not None:
                if group.gr_gid != self.gid or group.gr_mem:
                    raise RuntimeError("API fixture group identity changed")
                subprocess.run(["/usr/sbin/groupdel", self.name], check=True)
            for lookup in (pwd.getpwnam, grp.getgrnam):
                try:
                    lookup(self.name)
                except KeyError:
                    continue
                raise RuntimeError("API fixture account/group cleanup incomplete")
        if self.fixtures is not None:
            self.fixtures.close()
            self.fixtures = None


def stop_and_reap(account, child, requested=None):
    if account.uid is None or not account.owns_uid:
        return 0
    reaped = 0
    signal_tasks(account.uid, getattr(signal, requested) if requested else signal.SIGTERM)
    grace = time.monotonic() + 1
    deadline = grace + 5
    while owned_tasks(account.uid):
        if child is not None:
            child.poll()
        reaped += reap_adopted(child.pid if child is not None else None)
        if time.monotonic() >= grace:
            signal_tasks(account.uid, signal.SIGKILL)
        if time.monotonic() >= deadline:
            raise RuntimeError("API fixture tasks did not terminate/reap")
        time.sleep(0.01)
    if child is not None:
        child.wait()
    reaped += reap_adopted(None)
    if Path(f"/proc/self/task/{os.getpid()}/children").read_text().split():
        raise RuntimeError("API supervisor has unreaped adopted children")
    return reaped


def run_suite(api, node, control):
    env = validate_bootstrap(control.bootstrap(), api)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("API CI supervisor requires privileged Linux execution")
    node = node.resolve(strict=True)
    jest = api / "node_modules/jest/bin/jest.js"
    if node.name != "node" or not node.is_file() or not os.access(node, os.X_OK) or not jest.is_file():
        raise RuntimeError("API CI Node/Jest executable is unavailable")
    enable_subreaper()
    account = OwnedAccount()
    child = None
    requested = None
    outcome = 1
    previous = {}
    reaped = 0
    def receive(signum, _frame):
        nonlocal requested
        requested = requested or signal.Signals(signum).name
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.signal(signum, receive)
    try:
        account.create()
        env = ci_jest_environment(env, account)
        workspace = snapshot_workspace(api.parent.parent, account.root / "workspace", account.uid, account.gid)
        account.identities[workspace] = directory_identity(workspace, account.uid)
        mirrored_api = workspace / "apps/api"
        # GITHUB_WORKSPACE retains original bootstrap provenance; cwd/Jest and
        # their relative imports use the owned prepared snapshot.
        child = subprocess.Popen(account.command(node, mirrored_api / "node_modules/jest/bin/jest.js"), cwd=mirrored_api, env=env, stdin=subprocess.DEVNULL, start_new_session=True)
        print(f"API CI fixture account={account.name} uid={account.uid} full-suite=runInBand", file=sys.stderr, flush=True)
        while child.poll() is None:
            account.fixtures.observe(account.uid)
            messages = control.poll()
            requested = requested or (messages[0] if messages else None)
            if requested or control.eof:
                outcome = {"SIGINT": 130, "SIGTERM": 143}.get(requested, 1)
                break
            reaped += reap_adopted(child.pid)
            time.sleep(0.01)
        else:
            outcome = child.returncode if child.returncode >= 0 else 128 - child.returncode
            reaped += reap_adopted(child.pid)
            remaining = owned_tasks(account.uid)
            if outcome == 0 and remaining:
                print("API CI successful Jest left unexpected owned children: " + json.dumps(remaining), file=sys.stderr)
                outcome = 1
    finally:
        try:
            reaped += stop_and_reap(account, child, requested)
            account.cleanup()
            print(f"API CI cleanup uid={account.uid} tasks=0 adopted-reaped={reaped} account=absent temporary=absent", file=sys.stderr, flush=True)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
    return {"SIGINT": 130, "SIGTERM": 143}.get(requested, outcome)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    # sudo provenance is a CI invocation check, not an authorization boundary on
    # an already sudo-enabled runner. Never accept a caller-selected cleanup UID.
    caller = int(os.environ.get("SUDO_UID", "0"))
    if caller <= 0 or pwd.getpwuid(caller).pw_name != os.environ.get("SUDO_USER"):
        raise RuntimeError("API supervisor must be launched by the nonroot sudo runner")
    api = Path(__file__).resolve().parent.parent
    return run_suite(api, Path(args.node), ControlPipe(sys.stdin.fileno()))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("API CI supervisor failed: " + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
