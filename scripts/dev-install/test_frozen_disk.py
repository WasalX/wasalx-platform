#!/usr/bin/env python3
"""Focused unit tests for the frozen-disk host templates."""

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch


def load(name, parent="templates"):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(parent) / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


disk = load("frozen-disk")
maintenance = load("host-maintenance")


class HostPacketTest(unittest.TestCase):
    def test_renderer_seals_host_files_and_leaves_guest_files_out(self):
        here = Path(__file__).parent
        identity = here / "fixtures" / "host-identity.example.json"
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            budgets = parent / "lease-budgets.json"
            budgets.write_text('{"install": 30, "rollback": 19}', encoding="utf-8")
            packet = parent / "packet"
            subprocess.run([
                sys.executable, "-I", "-B", here / "render.py", "--host-identity", identity,
                "--lease-budgets", budgets, "--run-id", "20000101T000000Z",
                "--commit", "1" * 40, "--output", packet,
            ], check=True, timeout=10)
            hashes = dict(line.split("  ", 1)[::-1] for line in (packet / "SHA256SUMS").read_text().splitlines())
            self.assertEqual(set(hashes), {file.name for file in packet.iterdir()} - {"SHA256SUMS"})
            self.assertTrue({"overlay-action.sh", "frozen-disk.py", "register.sh", "host.env"}.issubset(hashes))
            self.assertFalse({"packet.json", "receive.py", "dispatch.py"}.intersection(hashes))
            for name, sha256 in hashes.items():
                self.assertEqual(hashlib.sha256((packet / name).read_bytes()).hexdigest(), sha256)
            self.assertIn("export INSTALL_SECONDS=30", (packet / "host.env").read_text())


class DiskProofTest(unittest.TestCase):
    def setUp(self):
        self.top = Path("/fixture/top.qcow2")
        self.frozen = disk.FrozenDisk.__new__(disk.FrozenDisk)
        self.frozen.top = self.top
        self.identity = {
            "device": 1, "inode": 2, "owner": 0, "group": 0, "size": 100,
            "mtime": 123, "ctime": 456, "mode": 0o400,
        }

    def test_immutable_and_identity_are_each_required(self):
        for flag, changed, reason in [
            (False, {}, "IMMUTABLE_FLAG"),
            (True, {"ctime": 789}, "DISK_CTIME"),
            (True, {"size": 101, "ctime": 789}, "DISK_SIZE"),
            (True, {"inode": 9}, "DISK_INODE"),
        ]:
            with (self.subTest(reason=reason), patch.object(disk, "locked", return_value=flag),
                  patch.object(disk, "identity", return_value={**self.identity, **changed})):
                with self.assertRaisesRegex(disk.Hold, reason):
                    self.frozen.check_identity(self.identity)

    def test_preboot_proof_checks_identity_twice_and_does_not_hash(self):
        overlay = Path("/fixture/overlay.qcow2")
        with (patch.object(self.frozen, "check_identity") as compare,
              patch.object(self.frozen, "structural_proof") as structure,
              patch.object(self.frozen, "load", return_value={
                  "phase": "sealed", "identity": self.identity, "audited_ns": disk.time.time_ns(),
              }),
              patch.object(disk, "digest") as hash_bytes):
            self.frozen.frozen_check(overlay=overlay)
        self.assertEqual(compare.call_count, 2)
        structure.assert_called_once_with(overlay)
        hash_bytes.assert_not_called()

    def test_daily_audit_requires_sha_and_pending_commit_cannot_proceed(self):
        current = {**self.identity, "mode": 0o600}
        receipt = {"phase": "sealed", "identity": self.identity, "sha256": "1" * 64, "audited_ns": 1}
        with (patch.object(self.frozen, "load", return_value=receipt),
              patch.object(self.frozen, "check_identity"), patch.object(self.frozen, "structural_proof"),
              patch.object(disk, "digest", return_value="2" * 64),
              patch.object(disk, "identity", return_value=current)):
            with self.assertRaisesRegex(disk.Hold, "DAILY_AUDIT_DUE"):
                self.frozen.frozen_check()
            with self.assertRaisesRegex(disk.Hold, "DISK_SHA256"):
                self.frozen.frozen_check(audit=True)
            receipt.update(phase="committing", run_id="20000101T000000Z")
            with self.assertRaisesRegex(disk.Hold, "INTERRUPTED_DISK_WRITE"):
                self.frozen.recover_offline("committing", "20000101T000000Z")

    def test_chain_requires_full_expected_path_and_backing_format(self):
        paths = ["/fixture/overlay", "/fixture/top"]
        layer = {"filename": paths[0], "virtual-size": 8, "format": "qcow2",
                 "full-backing-filename": paths[1], "backing-filename-format": "qcow2"}
        metadata = [layer, {"filename": paths[1], "format": "qcow2"}]
        with patch.object(disk, "run", side_effect=["", json.dumps(metadata)]) as command:
            disk.check_chain(paths, 8, overlay=True)
        command.assert_any_call("qemu-img", "check", "-U", "-f", "qcow2", paths[0])
        layer["full-backing-filename"] = "/fixture/other"
        with patch.object(disk, "run", side_effect=["", json.dumps(metadata)]):
            with self.assertRaisesRegex(disk.Hold, "BACKING_CHAIN"):
                disk.check_chain(paths, 8, overlay=True)


class LeaseBudgetTest(unittest.TestCase):
    def receipt(self, phase, duration):
        start = 1_700_000_000_000_000_000
        terminal = "DEV_SIGNED_INSTALL=PASS release=HELD" if phase == "install" else "DISCARD_OVERLAY=PASS TOP_RESTORED"
        return (
            f"PHASE_TIMING phase={phase} step=lease event=start epoch_ns={start} at=test\n"
            f"PHASE_TIMING phase={phase} step=lease event=pass epoch_ns={start + duration} at=test\n"
            f"{terminal} test"
        )

    def test_p100_and_rounded_margin_with_multiple_receipts(self):
        receipts = [self.receipt("install", 5_000_000_000), self.receipt("install", 8_000_000_001),
                    self.receipt("rollback", 3_000_000_000)]
        self.assertEqual(maintenance.lease_budgets(receipts), {"install": 11, "rollback": 4})

    def test_requires_complete_pass_for_both_phases(self):
        with self.assertRaisesRegex(ValueError, "complete"):
            maintenance.lease_budgets([self.receipt("install", 1_000_000_000)])
        with self.assertRaisesRegex(ValueError, "unbound"):
            maintenance.lease_budgets(["DISCARD_OVERLAY=PASS TOP_RESTORED test"])

    @unittest.skipUnless(hasattr(maintenance.os, "geteuid"), "Linux directory custody")
    def test_archive_needs_bound_terminal_pass_and_is_resumable(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            source, archive = (parent / name for name in ("support", "archive"))
            source.mkdir(mode=0o700)
            archive.mkdir(mode=0o700)
            run_id = "20000101T000000Z"
            (source / "run-id").write_text(run_id, encoding="ascii")
            log = source / "rollback.raw"
            log.write_text("DISCARD_OVERLAY=HOLD ROLLBACK_BRANCH_FAILED\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "terminal PASS"):
                maintenance.archive_support(source, archive, run_id, log.name)
            log.write_text("DISCARD_OVERLAY=PASS TOP_RESTORED test\n", encoding="utf-8")
            maintenance.archive_support(source, archive, run_id, log.name)
            self.assertFalse(source.exists())
            self.assertTrue((archive / run_id / log.name).is_file())
            maintenance.archive_support(source, archive, run_id, log.name)


if __name__ == "__main__":
    unittest.main()
