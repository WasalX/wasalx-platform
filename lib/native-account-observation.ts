import type { NativeAccountObservation } from "./control-plane-data";

export function nativeAccountObservationState(
  observation: NativeAccountObservation | undefined,
  expected?: { revision: string | number; nativeUserId: string | null },
): NativeAccountObservation["state"] {
  if (!observation) return "UNVERIFIED";
  if (observation.state === "UNAVAILABLE") return "UNAVAILABLE";
  if (!observation.checkedAt || !Number.isFinite(Date.parse(observation.checkedAt))
    || !Number.isSafeInteger(observation.revision) || observation.revision < 1
    || typeof observation.nativeUserId !== "string" || !/^[1-9][0-9]{0,15}$/u.test(observation.nativeUserId) || !Number.isSafeInteger(Number(observation.nativeUserId))
    || (expected && (Number(expected.revision) !== observation.revision || expected.nativeUserId !== observation.nativeUserId))) return "UNVERIFIED";
  return observation.state === "VERIFIED" || observation.state === "DRIFT" ? observation.state : "UNVERIFIED";
}

export function teamNativeAccountObservation(
  shared: NativeAccountObservation | undefined,
  memberSnapshot: NativeAccountObservation | undefined,
): NativeAccountObservation | undefined {
  if (shared?.state !== "VERIFIED") return shared;
  return nativeAccountObservationState(memberSnapshot) === "VERIFIED"
    && memberSnapshot?.revision === shared.revision && memberSnapshot.nativeUserId === shared.nativeUserId ? shared : undefined;
}
