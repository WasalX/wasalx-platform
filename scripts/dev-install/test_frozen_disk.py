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


SECOND = 10**9


def timing(phase, step, duration):
    start = 1_700_000_000 * SECOND
    return (
        f"PHASE_TIMING phase={phase} step={step} event=start epoch_ns={start} at=2023-11-14T22:13:20Z\n"
        f"PHASE_TIMING phase={phase} step={step} event=pass epoch_ns={start + duration} at=2023-11-14T22:13:21Z\n"
    )


def lease_receipt(phase, duration, hash_timing=""):
    terminal = "DEV_SIGNED_INSTALL=PASS release=HELD" if phase == "install" else "DISCARD_OVERLAY=PASS TOP_RESTORED"
    start, end = timing(phase, "lease", duration).splitlines(keepends=True)
    return start + hash_timing + end + f"{terminal} 2023-11-14T22:13:21Z"


class HostPacketTest(unittest.TestCase):
    def render(self, packet, *lease_args):
        here = Path(__file__).parent
        identity = here / "fixtures" / "host-identity.example.json"
        return subprocess.run([
            sys.executable, "-I", "-B", here / "render.py", "--host-identity", identity,
            "--run-id", "20000101T000000Z", "--commit", "1" * 40, "--output", packet,
            *lease_args,
        ], capture_output=True, text=True, timeout=10)

    def test_renderer_seals_host_files_and_derives_measured_leases(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            install = parent / "install.raw"
            install.write_text(lease_receipt("install", 24 * SECOND, timing("install", "base-freeze", 8 * SECOND)),
                               encoding="utf-8")
            rollback = parent / "rollback.raw"
            rollback.write_text(lease_receipt("rollback", 7 * SECOND), encoding="utf-8")
            packet = parent / "packet"
            result = self.render(packet, "--lease-receipt", install, "--lease-receipt", rollback)
            self.assertEqual(result.returncode, 0, result.stderr)
            hashes = dict(line.split("  ", 1)[::-1] for line in (packet / "SHA256SUMS").read_text().splitlines())
            self.assertEqual(set(hashes), {file.name for file in packet.iterdir()} - {"SHA256SUMS"})
            self.assertTrue({"overlay-action.sh", "frozen-disk.py", "register.sh", "host.env"}.issubset(hashes))
            self.assertFalse({"packet.json", "receive.py", "dispatch.py"}.intersection(hashes))
            for name, sha256 in hashes.items():
                self.assertEqual(hashlib.sha256((packet / name).read_bytes()).hexdigest(), sha256)
            env = (packet / "host.env").read_text()
            self.assertIn("export INSTALL_SECONDS=30", env)
            self.assertIn("export DISCARD_SECONDS=19", env)
            self.assertIn("export LEASE_BUDGET_SOURCE=measured-receipts", env)

    def test_renderer_seals_reviewed_reservations_and_refuses_hand_typed_budgets(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            packet = parent / "packet"
            result = self.render(packet)
            self.assertEqual(result.returncode, 0, result.stderr)
            env = (packet / "host.env").read_text()
            self.assertIn("export INSTALL_SECONDS=13400", env)
            self.assertIn("export DISCARD_SECONDS=11400", env)
            self.assertIn("export LEASE_BUDGET_SOURCE=reviewed-reservations", env)

            budgets = parent / "budgets.json"
            budgets.write_text('{"install": 30, "rollback": 19}', encoding="utf-8")
            for option in ("--lease-budgets", "--lease-receipt"):
                with self.subTest(option=option):
                    rejected = parent / "rejected"
                    result = self.render(rejected, option, budgets)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(rejected.exists())


class DiskProofTest(unittest.TestCase):
    def setUp(self):
        self.top = Path("/fixture/top.qcow2")
        self.frozen = disk.FrozenDisk.__new__(disk.FrozenDisk)
        self.frozen.top = self.top
        self.frozen.paths = [str(self.top)]
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

    def test_overdue_audit_hashes_and_only_saves_on_a_match(self):
        for matches in (True, False):
            receipt = {"phase": "sealed", "identity": self.identity, "sha256": "1" * 64, "audited_ns": 1}
            with (self.subTest(matches=matches), patch.object(self.frozen, "load", return_value=receipt),
                  patch.object(self.frozen, "check_identity"), patch.object(self.frozen, "structural_proof"),
                  patch.object(self.frozen, "save") as save,
                  patch.object(disk, "digest", return_value=("1" if matches else "2") * 64) as hash_bytes):
                if matches:
                    self.frozen.frozen_check()
                    save.assert_called_once_with(receipt)
                    self.assertGreater(receipt["audited_ns"], 1)
                else:
                    with self.assertRaisesRegex(disk.Hold, "DISK_SHA256"):
                        self.frozen.frozen_check()
                    save.assert_not_called()
                    self.assertEqual(receipt["audited_ns"], 1)
                hash_bytes.assert_called_once_with(self.top)

    def test_pending_commit_cannot_proceed(self):
        run_id = "20000101T000000Z"
        receipt = {"phase": "committing", "identity": self.identity, "run_id": run_id}
        with (patch.object(self.frozen, "load", return_value=receipt),
              patch.object(self.frozen, "structural_proof"),
              patch.object(disk, "identity", return_value=self.identity)):
            with self.assertRaisesRegex(disk.Hold, "INTERRUPTED_DISK_WRITE"):
                self.frozen.recover_offline("committing", run_id)

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
    def test_p100_and_rounded_margin_includes_slowest_full_hash_in_discard(self):
        install = lease_receipt("install", 8_000 * SECOND + 1, timing("install", "base-freeze", 2_000 * SECOND))
        rollback = lease_receipt("rollback", 3_000 * SECOND, timing("rollback", "disk-recovery", 2_500 * SECOND))
        audit = timing("audit", "daily-base-hash", 2_880 * SECOND + 1)
        budget, source = maintenance.lease_budgets([lease_receipt("install", 5_000 * SECOND), install, rollback, audit])
        self.assertEqual(budget, {"install": 10_001, "rollback": 7_351})
        self.assertEqual(source, "measured-receipts")

    def test_falls_back_without_both_bound_passes_and_a_hash_measurement(self):
        install = lease_receipt("install", SECOND, timing("install", "base-freeze", SECOND))
        rollback = lease_receipt("rollback", SECOND)
        for receipts in ([], [install], [rollback], [lease_receipt("install", SECOND), rollback]):
            with self.subTest(receipts=len(receipts)):
                self.assertEqual(maintenance.lease_budgets(receipts),
                                 ({"install": 13_400, "rollback": 11_400}, "reviewed-reservations"))
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
