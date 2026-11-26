#!/usr/bin/env python3
"""Focused unit tests for the frozen-disk host templates."""

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch


def load(name, parent="templates"):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / parent / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


disk = load("frozen-disk")
maintenance = load("host-maintenance")
renderer = load("render", parent=".")


SECOND = 10**9
CAPTURED_NS = 1_700_000_000 * SECOND
RENDER_NS = CAPTURED_NS + 40 * SECOND
# overlay-action.sh stamps lease start, then verifies the packet, then captures the origin.
LEASE_START_NS = CAPTURED_NS - 2 * SECOND
ORIGIN = {"host_sha256": "1" * 64, "disk_device": 7, "disk_inode": 19}
POLICY = {**ORIGIN, "max_age_seconds": 60}


def receipt_origin(**overrides):
    values = {**ORIGIN, "captured_ns": CAPTURED_NS, **overrides}
    return "LEASE_RECEIPT_ORIGIN " + " ".join(f"{key}={value}" for key, value in values.items()) + "\n"


def timing(phase, step, duration, size=None, start=CAPTURED_NS):
    byte_count = f" bytes={size}" if size is not None else ""
    return (
        f"PHASE_TIMING phase={phase} step={step} event=start epoch_ns={start} at=2023-11-14T22:13:20Z{byte_count}\n"
        f"PHASE_TIMING phase={phase} step={step} event=pass epoch_ns={start + duration} at=2023-11-14T22:13:21Z{byte_count}\n"
    )


def lease_receipt(phase, duration, steps="", lease_start=LEASE_START_NS):
    terminal = {
        "install": "DEV_SIGNED_INSTALL=PASS release=HELD 2023-11-14T22:13:21Z",
        "rollback": "DISCARD_OVERLAY=PASS TOP_RESTORED 2023-11-14T22:13:21Z",
        "commit": "COMMIT_PASS 2023-11-14T22:13:21Z overlay_retained=fixture.qcow2",
    }
    start, end = timing(phase, "lease", duration, start=lease_start).splitlines(keepends=True)
    return start + steps + end + terminal[phase]


class HostPacketTest(unittest.TestCase):
    here = Path(__file__).parent
    example = here / "fixtures" / "host-identity.example.json"

    def render(self, packet, *lease_args, identity=None):
        return subprocess.run([
            sys.executable, "-I", "-B", self.here / "render.py", "--host-identity", identity or self.example,
            "--run-id", "20000101T000000Z", "--commit", "1" * 40, "--output", packet,
            *lease_args,
        ], capture_output=True, text=True, timeout=10)

    def test_host_steps_share_the_rendered_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory) / "packet"
            result = self.render(packet)
            self.assertEqual(result.returncode, 0, result.stderr)
            marker = json.loads(self.example.read_bytes())["DEV_STEP_LOCK"]
            env = (packet / "host.env").read_text()
            self.assertEqual([line for line in env.splitlines() if marker in line],
                             [f"export DEV_STEP_LOCK={marker}"])
            helper = (packet / "dev-step-lock.sh").read_text()
            self.assertIn('exec 7<"$DEV_STEP_LOCK"', helper)
            self.assertIn("flock -n -E 75 7", helper)
            self.assertNotIn(marker, helper)
            for name, state, lock, first_action in (
                ("register.sh", "STATE", "dev_step_record check || exit 75", 'exec 9>"$STATE/install-registration.lock"'),
                ("install-or-discard.sh", "state", 'hold_dev_step_lock "$run" "$mode" lease', "sha256sum --check"),
                ("overlay-action.sh", "STATE", 'hold_dev_step_lock "$RUN" "$MODE"', "stamp lease start"),
                ("dev-guest-phase.sh", "state", 'hold_dev_step_lock "$(cat "$state/run-id")" "guest-$phase"', "stamp ssh-ready start"),
            ):
                with self.subTest(step=name):
                    script = (packet / name).read_text()
                    acquisition = script.index(f"\n{lock}\n")
                    self.assertLess(script.index(f'source "${state}/dev-step-lock.sh"'), acquisition)
                    if name == "register.sh":
                        self.assertIn('/bin/bash "$STATE/install-or-discard.sh" "$STATE" "$MODE"', script)
                    self.assertLess(acquisition, script.index(first_action))
                    self.assertNotIn(marker, script)

    def test_host_identity_requires_an_absolute_marker_path(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            identity = parent / "host-identity.json"
            packet = parent / "packet"
            fields = json.loads(self.example.read_bytes())
            fields.pop("DEV_STEP_LOCK")
            for invalid_fields, error in (
                (fields, "invalid host identity fields"),
                ({**fields, "DEV_STEP_LOCK": "relative/active"}, "invalid host path: DEV_STEP_LOCK"),
            ):
                identity.write_text(json.dumps(invalid_fields), encoding="utf-8")
                result = self.render(packet, identity=identity)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertFalse(packet.exists())

    def test_renderer_seals_host_files_and_derives_measured_leases(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            install = parent / "install.raw"
            install_text = lease_receipt("install", 24 * SECOND, timing("install", "full-top-hash", 8 * SECOND, 2 * SECOND))
            install.write_text(receipt_origin() + install_text, encoding="utf-8")
            rollback = parent / "rollback.raw"
            rollback.write_text(receipt_origin(captured_ns=CAPTURED_NS + 1) + lease_receipt("rollback", 7 * SECOND),
                                encoding="utf-8")
            receipt_hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (install, rollback)]
            identity = parent / "identity.json"
            fields = {**json.loads(self.example.read_bytes()), "LEASE_RECEIPT_POLICY": POLICY,
                      "LEASE_RECEIPT_SHA256S": receipt_hashes}
            identity.write_text(json.dumps(fields), encoding="utf-8")
            packet = parent / "packet"
            args = ("--lease-receipt", install, "--lease-receipt", rollback)
            with patch.object(time, "time_ns", return_value=RENDER_NS):
                renderer.render_host(fields, "20000101T000000Z", "1" * 40, [install, rollback], packet)
            hashes = dict(line.split("  ", 1)[::-1] for line in (packet / "SHA256SUMS").read_text().splitlines())
            self.assertEqual(set(hashes), {file.name for file in packet.iterdir()} - {"SHA256SUMS"})
            self.assertTrue(
                {"overlay-action.sh", "frozen-disk.py", "register.sh", "run-install.sh", "host.env"}.issubset(hashes)
            )
            self.assertFalse({"packet.json", "receive.py", "dispatch.py"}.intersection(hashes))
            for name, sha256 in hashes.items():
                self.assertEqual(hashlib.sha256((packet / name).read_bytes()).hexdigest(), sha256)
            env = (packet / "host.env").read_text()
            action = (packet / "overlay-action.sh").read_text()
            capture = action.index('timing-origin "$TOP"')
            self.assertLess(action.index('lease_start="$(stamp lease start)"'), action.index("sha256sum --check"))
            self.assertLess(action.index("sha256sum --check"), capture)
            self.assertLess(capture, action.index('printf \'%s\\n\' "$lease_start"'))
            self.assertIn("export INSTALL_SECONDS=30", env)
            self.assertIn("export DISCARD_SECONDS=9", env)
            self.assertIn("export HASH_NS_PER_GB=4000000000", env)
            self.assertIn("export INSTALL_DISCARD_BUDGET_SOURCE=measured-receipts", env)
            self.assertIn(f"export LEASE_RECEIPT_SHA256S='{json.dumps(receipt_hashes)}'", env)

            rejected = parent / "rejected"
            missing = self.render(rejected, *args)
            self.assertIn("expected SHA-256 hashes", missing.stderr)
            install.write_bytes(install.read_bytes().replace(b"step=full-top-hash", b"step=base-freeze"))
            result = self.render(rejected, *args, identity=identity)
            self.assertIn("lease receipt SHA-256 mismatch", result.stderr)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(rejected.exists())

    def test_renderer_falls_back_for_legacy_receipts_even_when_their_digests_match(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            receipt = parent / "legacy.raw"
            receipt.write_text(lease_receipt("install", 24 * SECOND,
                               timing("install", "full-top-hash", SECOND, SECOND)) + "\n"
                               + lease_receipt("rollback", 7 * SECOND), encoding="utf-8")
            identity = parent / "identity.json"
            identity.write_text(json.dumps({**json.loads(self.example.read_bytes()),
                                            "LEASE_RECEIPT_SHA256S": [hashlib.sha256(receipt.read_bytes()).hexdigest()]}),
                                encoding="utf-8")
            packet = parent / "packet"
            result = self.render(packet, "--lease-receipt", receipt, identity=identity)
            self.assertEqual(result.returncode, 0, result.stderr)
            env = (packet / "host.env").read_text()
            self.assertIn("export INSTALL_SECONDS=13400", env)
            self.assertIn("export DISCARD_SECONDS=11400", env)
            self.assertIn("export COMMIT_FALLBACK_SECONDS=25050", env)

    def test_renderer_falls_back_when_any_receipt_has_the_wrong_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            install, rollback = (parent / name for name in ("install.raw", "rollback.raw"))
            install.write_text(receipt_origin() + lease_receipt(
                "install", 24 * SECOND, timing("install", "full-top-hash", 8 * SECOND, 2 * SECOND)), encoding="utf-8")
            fresh = lease_receipt("rollback", 7 * SECOND)
            # Starts just before the oldest allowed tick and ends after capture, so only the stale start is wrong.
            stale = lease_receipt("rollback", 25 * SECOND, lease_start=RENDER_NS - 60 * SECOND - 1)
            for name, override, text in (
                ("other-host", {"host_sha256": "2" * 64}, fresh),
                ("other-device", {"disk_device": 8}, fresh),
                ("other-inode", {"disk_inode": 20}, fresh),
                ("expired", {"captured_ns": RENDER_NS - 60 * SECOND - 1}, fresh),
                ("future", {"captured_ns": RENDER_NS + 1}, fresh),
                ("older-timings", {"captured_ns": CAPTURED_NS + 8 * SECOND}, fresh),
                ("stale-lease-start", {}, stale),
            ):
                with self.subTest(name=name):
                    rollback.write_text(receipt_origin(**override) + text, encoding="utf-8")
                    inputs = [install, rollback]
                    fields = {**json.loads(self.example.read_bytes()), "LEASE_RECEIPT_POLICY": POLICY,
                              "LEASE_RECEIPT_SHA256S": [hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs]}
                    packet = parent / name
                    with patch.object(time, "time_ns", return_value=RENDER_NS):
                        renderer.render_host(fields, "20000101T000000Z", "1" * 40, inputs, packet)
                    env = (packet / "host.env").read_text()
                    self.assertIn("export INSTALL_SECONDS=13400", env)
                    self.assertIn("export DISCARD_SECONDS=11400", env)
                    self.assertIn("export HASH_NS_PER_GB=0", env)
                    self.assertIn("export COMMIT_FALLBACK_SECONDS=25050", env)

    def test_renderer_seals_reviewed_reservations_and_refuses_hand_typed_budgets(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            packet = parent / "packet"
            result = self.render(packet)
            self.assertEqual(result.returncode, 0, result.stderr)
            env = (packet / "host.env").read_text()
            self.assertIn("export INSTALL_SECONDS=13400", env)
            self.assertIn("export DISCARD_SECONDS=11400", env)
            self.assertIn("export INSTALL_DISCARD_BUDGET_SOURCE=reviewed-reservations", env)
            self.assertIn("export COMMIT_FALLBACK_SECONDS=25050", env)
            self.assertIn("export LEASE_BUDGET_SOURCE=fallback-commit", env)

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
    def test_timing_origin_records_local_machine_and_top_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            top = Path(directory) / "top.qcow2"
            top.write_bytes(b"fixture")
            machine_id = "12" * 16
            with (patch.object(maintenance.Path, "read_text", return_value=machine_id),
                  patch.object(time, "time_ns", return_value=CAPTURED_NS)):
                origin = maintenance.timing_origin(top)
            self.assertNotIn(machine_id, origin)
            host, device, inode, captured = maintenance.ORIGIN.fullmatch(origin).groups()
            self.assertEqual(host, "ff3ecd23b6c8f19a456114fa7ecbbc2de378b6f45b0fd660485c9ef0780299c7")
            self.assertEqual((int(device), int(inode), int(captured)),
                             (top.stat().st_dev, top.stat().st_ino, CAPTURED_NS))

    def test_p100_and_rounded_margin_scale_hashes_with_current_top_size(self):
        install = lease_receipt("install", 8_000 * SECOND + 1, timing("install", "full-top-hash", 10 * SECOND + 1, 100))
        rollback = lease_receipt("rollback", 3_000 * SECOND, timing("rollback", "disk-recovery", 2_500 * SECOND))
        audit = timing("audit", "full-top-hash", 12 * SECOND, 200)
        budget = maintenance.lease_budgets([lease_receipt("install", 5_000 * SECOND), install, rollback, audit])
        self.assertEqual(budget["INSTALL_DISCARD_BUDGET_SOURCE"], "measured-receipts")
        with tempfile.TemporaryDirectory() as directory:
            top = Path(directory) / "top.qcow2"
            top.write_bytes(bytes(100))
            env = {**budget, "TOP": top}
            self.assertEqual(maintenance.lease_runtime("rollback", env), 3_763)
            top.write_bytes(bytes(200))
            self.assertEqual(maintenance.lease_runtime("rollback", env), 3_776)
            self.assertEqual(maintenance.lease_runtime("install", env), 13_777)

    def test_falls_back_without_both_bound_passes_and_a_hash_measurement(self):
        install = lease_receipt("install", SECOND, timing("install", "full-top-hash", SECOND, 100))
        rollback = lease_receipt("rollback", SECOND)
        legacy = lease_receipt("install", SECOND, timing("install", "base-freeze", SECOND))
        for receipts in ([], [install], [rollback], [legacy, rollback]):
            with self.subTest(receipts=len(receipts)):
                budget = maintenance.lease_budgets(receipts)
                self.assertEqual(budget["INSTALL_DISCARD_BUDGET_SOURCE"], "reviewed-reservations")
                self.assertEqual(maintenance.lease_runtime("install", budget), 24_800)
                self.assertEqual(maintenance.lease_runtime("rollback", budget), 11_400)
                self.assertEqual(maintenance.lease_runtime("commit", budget), 25_050)
                self.assertEqual(budget["LEASE_BUDGET_SOURCE"], "fallback-commit")
        with self.assertRaisesRegex(ValueError, "unbound"):
            maintenance.lease_budgets(["DISCARD_OVERLAY=PASS TOP_RESTORED test"])
        inconsistent = timing("audit", "full-top-hash", SECOND, 100).replace("21Z bytes=100", "21Z bytes=200")
        with self.assertRaisesRegex(ValueError, "invalid phase timing"):
            maintenance.lease_budgets([inconsistent])

    def test_commit_reserves_scaled_hashes_and_commit_work_with_a_fallback_floor(self):
        def commit(qemu, size, restore):
            steps = timing("commit", "full-top-hash", 3_000 * SECOND, 100)
            steps += timing("commit", "qemu-commit", qemu * SECOND, size)
            steps += timing("commit", "top-restore", restore * SECOND)
            return lease_receipt("commit", 50_000 * SECOND, steps)

        first = commit(8_000, 50, 2_000)
        second = commit(12_000, 100, 6_500)
        interrupted = commit(30_000, 50, 10_000).rsplit("\n", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            top = Path(directory) / "top.qcow2"
            overlay = Path(directory) / "overlay.qcow2"
            top.write_bytes(bytes(100))
            budget = maintenance.lease_budgets([first, second, interrupted])
            self.assertEqual(budget["LEASE_BUDGET_SOURCE"], "measured-receipts")
            env = {**budget, "TOP": top, "OVERLAY": overlay}
            overlay.write_bytes(bytes(25))
            self.assertEqual(maintenance.lease_runtime("commit", env), 25_050)
            overlay.write_bytes(bytes(50))
            self.assertEqual(maintenance.lease_runtime("commit", env), 27_500)
            overlay.write_bytes(bytes(100))
            self.assertEqual(maintenance.lease_runtime("commit", env), 39_375)
            legacy = commit(8_000, None, 2_000)
            mixed = maintenance.lease_budgets([first, second, legacy])
            self.assertEqual(mixed["LEASE_BUDGET_SOURCE"], "fallback-commit")
            self.assertEqual(maintenance.lease_runtime("commit", {**env, **mixed}), 39_375)
            top.write_bytes(bytes(200))
            self.assertEqual(maintenance.lease_runtime("commit", env), 46_875)
            overlay.unlink()
            self.assertEqual(maintenance.lease_runtime("commit", env), 25_050)
            self.assertEqual(maintenance.lease_runtime("commit", maintenance.lease_budgets([interrupted])), 25_050)

    def test_unsized_commit_timing_forces_fallback(self):
        hashes = timing("commit", "full-top-hash", 8 * SECOND, 100)
        restore = timing("commit", "top-restore", 45 * SECOND)
        legacy = lease_receipt("commit", 90 * SECOND,
                               hashes + timing("commit", "qemu-commit", 20 * SECOND) + restore)
        budget = maintenance.lease_budgets([legacy])
        self.assertEqual(budget["LEASE_BUDGET_SOURCE"], "fallback-commit")
        self.assertEqual(maintenance.lease_runtime("commit", budget), 25_050)

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
