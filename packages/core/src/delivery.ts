export function backoffMs(attempt:number,random=Math.random){const base=Math.min(15*60_000,1_000*2**Math.max(0,attempt-1));return Math.round(base*(.75+random()*.5))}

export const DEFAULT_MAX_ATTEMPTS = 8;
// The handoff claim and table constraint cap attempts at eight.
export const MAX_BOT_HANDOFF_ATTEMPTS = 8;

export function boundedAttempts(value: string | undefined, key: string, maximum = 25): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > maximum) {
    throw new Error(`${key} must be an integer between 1 and ${maximum}`);
  }
  return attempts;
}

export function botHandoffMaxAttemptsFromEnvironment(env: Record<string, string | undefined>): number {
  return boundedAttempts(env.BOT_HANDOFF_MAX_ATTEMPTS, "BOT_HANDOFF_MAX_ATTEMPTS", MAX_BOT_HANDOFF_ATTEMPTS);
}
