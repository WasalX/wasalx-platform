import assert from "node:assert/strict";
import { fstatSync, readFileSync, statSync } from "node:fs";

export const composeStageLockPath = JSON.parse(readFileSync(new URL("./compose-stage-config.json", import.meta.url))).lockPath;
export const composeStageLockConflict = 75;

export function assertComposeStageLock(fd, ownerPid = process.pid) {
  assert.ok(Number.isSafeInteger(fd) && fd >= 3, "stage lock fd is invalid");
  const actual = fstatSync(fd, { bigint: true }), expected = statSync(composeStageLockPath, { bigint: true });
  assert.equal(actual.dev, expected.dev, "stage lock fd device changed");
  assert.equal(actual.ino, expected.ino, "stage lock fd inode changed");
  const major = ((actual.dev >> 8n) & 0xfffn) | ((actual.dev >> 32n) & ~0xfffn);
  const minor = (actual.dev & 0xffn) | ((actual.dev >> 12n) & ~0xffn);
  assert.ok(readFileSync("/proc/locks", "utf8").split("\n").some((line) => {
    const match = line.match(/^\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/iu);
    return match && Number(match[1]) === ownerPid && BigInt(`0x${match[2]}`) === major && BigInt(`0x${match[3]}`) === minor && BigInt(match[4]) === actual.ino;
  }), "stage lock fd is not owned by this execution");
}

export function enterComposeStageLock(arguments_, environment, command, entrypoint) {
  const index = arguments_.indexOf("--stage-lock-fd");
  if (index >= 0) {
    assertComposeStageLock(Number(arguments_[index + 1]));
    return null;
  }
  // --no-fork preserves the lock owner's PID across exec. Only stdin/out/err are
  // inherited, so flock's first open is fd 3; re-entry verifies inode and owner.
  return command("flock", ["--no-fork", "--nonblock", "--conflict-exit-code", String(composeStageLockConflict),
    composeStageLockPath, process.execPath, entrypoint, ...arguments_, "--stage-lock-fd", "3"], environment, true);
}
