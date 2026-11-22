#!/usr/bin/env python3
"""The D2 frozen TOP proof, run under the signed host action's disk lock."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time


class Hold(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Hold(code)


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_receipt(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(data, file, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
        sync_dir(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def read_receipt(path):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.geteuid()
            and st.st_nlink == 1 and stat.S_IMODE(st.st_mode) == 0o600, "RECEIPT_CUSTODY")
    return json.loads(path.read_bytes())


def identity(path):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, "DISK_FILE")
    return {
        "device": st.st_dev, "inode": st.st_ino, "owner": st.st_uid, "group": st.st_gid,
        "size": st.st_size, "mtime": st.st_mtime_ns, "ctime": st.st_ctime_ns,
        "mode": stat.S_IMODE(st.st_mode),
    }


def same_inode(actual, expected):
    return all(actual[key] == expected[key] for key in ("device", "inode", "owner", "group"))


def locked(path):
    attrs = run("lsattr", "-d", "--", path).split()
    require(len(attrs) >= 2, "DISK_FLAGS_UNREADABLE")
    return "i" in attrs[0]


def check_chain(paths, virtual_size, *, overlay=False):
    run("qemu-img", "check", "-U", "-f", "qcow2", paths[0])
    chain = json.loads(run("qemu-img", "info", "-U", "--backing-chain", "--output=json", paths[0]))
    require([layer["filename"] for layer in chain] == paths, "BACKING_CHAIN")
    require([layer.get("full-backing-filename") for layer in chain] == [*paths[1:], None],
            "BACKING_CHAIN")
    require(all(layer["format"] == "qcow2" and not layer.get("dirty-flag")
                and not layer.get("format-specific", {}).get("data", {}).get("corrupt")
                for layer in chain), "BACKING_CHAIN")
    require(chain[0]["virtual-size"] == virtual_size, "VIRTUAL_SIZE")
    if overlay:
        require(chain[0].get("backing-filename-format") == "qcow2", "OVERLAY_BACKING_FORMAT")


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


class FrozenDisk:
    def __init__(self, state, paths, virtual_size):
        st = state.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid()
                and stat.S_IMODE(st.st_mode) == 0o700, "DISK_STATE_CUSTODY")
        self.receipt = state / "frozen-top.json"
        self.hold = state / "frozen-top.hold"
        self.paths = paths
        self.top = Path(paths[0])
        self.virtual_size = virtual_size

    def load(self):
        receipt = read_receipt(self.receipt)
        require(receipt["chain"] == self.paths and receipt["virtual_size"] == self.virtual_size,
                "DISK_CHAIN_BINDING")
        return receipt

    def save(self, receipt):
        write_receipt(self.receipt, {**receipt, "chain": self.paths, "virtual_size": self.virtual_size})

    def structural_proof(self, overlay=None):
        check_chain(self.paths, self.virtual_size)
        if overlay is not None:
            check_chain([str(overlay), *self.paths], self.virtual_size, overlay=True)

    def check_identity(self, expected):
        require(locked(self.top), "IMMUTABLE_FLAG")
        actual = identity(self.top)
        require(same_inode(actual, expected), "DISK_INODE")
        require(actual["size"] == expected["size"], "DISK_SIZE")
        require(actual["ctime"] == expected["ctime"], "DISK_CTIME")
        require(actual == expected, "DISK_IDENTITY")

    def frozen_check(self, *, overlay=None, audit=False):
        """At preboot this replaces the post-create byte comparison under D2."""
        receipt = self.load()
        require(receipt["phase"] == "sealed", "RECOVERY_REQUIRED")
        expected = receipt["identity"]
        self.check_identity(expected)
        self.structural_proof(overlay)
        now = time.time_ns()
        if audit:
            require(digest(self.top) == receipt["sha256"], "DISK_SHA256")
            receipt["audited_ns"] = time.time_ns()
        else:
            require(0 <= now - receipt["audited_ns"] <= 86_400 * 10**9, "DAILY_AUDIT_DUE")
        self.check_identity(expected)
        if audit:
            self.save(receipt)
        return receipt

    def seal(self, previous, *, new_generation):
        before = identity(self.top)
        require(locked(self.top), "IMMUTABLE_FLAG")
        self.structural_proof()
        if new_generation:
            previous = {
                **previous, "sha256": digest(self.top), "audited_ns": time.time_ns(),
                "generation": previous.get("generation", 0) + 1,
            }
        self.check_identity(before)
        self.save({**previous, "identity": before, "phase": "sealed"})

    def freeze(self, run_id):
        previous = self.load() if os.path.lexists(self.receipt) else {}
        if previous.get("phase") == "sealed":
            self.frozen_check()
            return
        require(previous.get("phase") in (None, "writable"), "RECOVERY_REQUIRED")
        current = identity(self.top)
        require(current["mode"] == 0o600 and not locked(self.top), "WRITABLE_TOP_MODE")
        if previous:
            require(same_inode(current, previous["identity"]), "DISK_INODE")
        self.save({**previous, "phase": "sealing", "run_id": run_id, "identity": current})
        self.top.chmod(0o400)
        run("chattr", "+i", "--", self.top)
        after = identity(self.top)
        require(same_inode(after, current)
                and all(after[key] == current[key] for key in ("size", "mtime")), "FREEZE_DISK_IDENTITY")
        self.seal({key: previous[key] for key in ("generation",) if key in previous}, new_generation=True)

    def restore_mode(self, run_id):
        receipt = self.frozen_check()
        if receipt["identity"]["mode"] == 0o600:
            return
        require(receipt["identity"]["mode"] == 0o400, "FROZEN_TOP_MODE")
        self.save({**receipt, "phase": "mode-restore", "run_id": run_id})
        run("chattr", "-i", "--", self.top)
        self.top.chmod(0o600)
        run("chattr", "+i", "--", self.top)
        after = identity(self.top)
        before = receipt["identity"]
        require(same_inode(after, before) and all(after[key] == before[key] for key in ("size", "mtime")),
                "MODE_RESTORE_IDENTITY")
        self.seal(receipt, new_generation=False)

    def begin_writable(self, run_id):
        receipt = self.frozen_check()
        require(receipt["identity"]["mode"] == 0o600, "WRITABLE_TOP_MODE")
        self.save({**receipt, "phase": "booting", "run_id": run_id})
        run("chattr", "-i", "--", self.top)
        after = identity(self.top)
        prior = receipt["identity"]
        require(not locked(self.top) and same_inode(after, prior)
                and all(after[key] == prior[key] for key in ("size", "mtime", "mode")), "BOOT_DISK_IDENTITY")

    def writable_receipt(self, run_id):
        receipt = self.load()
        require(receipt["phase"] in ("booting", "writable") and receipt.get("run_id") == run_id,
                "BOOT_RECOVERY_BINDING")
        current = identity(self.top)
        require(same_inode(current, receipt["identity"]) and current["mode"] == 0o600
                and not locked(self.top), "BOOT_DISK_IDENTITY")
        return {**receipt, "phase": "writable", "identity": current}

    def recover_offline(self, phase, run_id):
        receipt = self.load()
        require(receipt["phase"] == phase and receipt["run_id"] == run_id, "RECOVERY_BINDING")
        current = identity(self.top)
        require(same_inode(current, receipt["identity"]) and current["mode"] in (0o400, 0o600),
                "RECOVERY_DISK_IDENTITY")
        if phase in ("sealing", "committing"):
            self.structural_proof()
            raise Hold("INTERRUPTED_DISK_WRITE")
        require(phase in ("mode-restore", "booting"), "RECOVERY_PHASE")
        if current["mode"] != 0o600:
            run("chattr", "-i", "--", self.top)
            self.top.chmod(0o600)
        run("chattr", "+i", "--", self.top)
        confirmed = identity(self.top)
        self.structural_proof()
        require(digest(self.top) == receipt["sha256"], "RECOVERY_DISK_SHA256")
        self.check_identity(confirmed)
        self.save({**receipt, "phase": "sealed", "identity": confirmed, "audited_ns": time.time_ns()})

    def commit(self, overlay, run_id):
        receipt = self.frozen_check(overlay=overlay, audit=True)
        self.save({**receipt, "phase": "committing", "run_id": run_id})
        run("chattr", "-i", "--", self.top)
        self.top.chmod(0o600)
        run("qemu-img", "commit", "-f", "qcow2", "-b", self.top, "-d", overlay)
        self.top.chmod(0o400)
        run("chattr", "+i", "--", self.top)
        require(same_inode(identity(self.top), receipt["identity"]), "DISK_INODE")
        self.seal({"generation": receipt["generation"], "committed_run": run_id}, new_generation=True)


def verify_stopped_overlay(source, target, receipt_path):
    expected = read_receipt(receipt_path)
    if os.path.lexists(source):
        require(not os.path.lexists(target) and identity(source) == expected, "OVERLAY_ARCHIVE_IDENTITY")
    else:
        current = identity(target)
        require(same_inode(current, expected)
                and all(current[key] == expected[key] for key in ("size", "mtime", "mode")),
                "OVERLAY_ARCHIVE_IDENTITY")


def archive_overlay(source, target, receipt_path):
    verify_stopped_overlay(source, target, receipt_path)
    if os.path.lexists(source):
        run("mv", "-T", "--no-clobber", "--", source, target)
        sync_dir(source.parent)
    require(not os.path.lexists(source), "OVERLAY_ARCHIVE_SOURCE")
    verify_stopped_overlay(source, target, receipt_path)


def main():
    action, *args = sys.argv[1:]
    disk = FrozenDisk(Path(os.environ["DISK_STATE"]), json.loads(os.environ["TOP_CHAIN"]),
                      int(os.environ["VIRTUAL_BYTES"]))
    require(not os.path.lexists(disk.hold), "DISK_HOLD")
    try:
        if action == "phase":
            print(disk.load()["phase"] if os.path.lexists(disk.receipt) else "uninitialized")
        elif action == "freeze":
            disk.freeze(args[0])
        elif action == "preboot":
            disk.frozen_check(overlay=Path(args[0]))
        elif action == "verify":
            disk.frozen_check()
        elif action == "audit":
            disk.frozen_check(audit=True)
        elif action == "restore-mode":
            disk.restore_mode(args[0])
        elif action == "begin-writable":
            disk.begin_writable(args[0])
        elif action == "verify-writable":
            disk.writable_receipt(args[0])
        elif action == "finish-writable":
            disk.save(disk.writable_receipt(args[0]))
        elif action == "recover-offline":
            disk.recover_offline(args[0], args[1])
        elif action == "commit":
            disk.commit(Path(args[0]), args[1])
        elif action == "committed":
            return 0 if disk.load().get("committed_run") == args[0] else 1
        elif action == "archive-overlay":
            archive_overlay(*(Path(path) for path in args))
        elif action == "verify-stopped-overlay":
            verify_stopped_overlay(*(Path(path) for path in args))
        elif action == "record-overlay-stop":
            path, receipt = map(Path, args)
            current = identity(path)
            if os.path.lexists(receipt):
                require(read_receipt(receipt) == current, "STOPPED_OVERLAY_IDENTITY")
            else:
                write_receipt(receipt, current)
        else:
            raise Hold("DISK_ACTION")
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, Hold) as error:
        code = str(error) if isinstance(error, Hold) else "DISK_COMMAND_OR_RECEIPT"
        if code != "DAILY_AUDIT_DUE":
            write_receipt(disk.hold, {"reason": code, "observed_ns": time.time_ns()})
        raise Hold(code) from None
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Hold as error:
        sys.exit(f"HOLD_{error}")
