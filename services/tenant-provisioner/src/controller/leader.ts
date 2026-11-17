import type { ControllerConfig } from "./config.js";
import {
  KubernetesDependencyError,
  type ControllerKubernetesClient,
  type LeaseRecord,
} from "./kubernetes.js";

export type LeaderClock = {
  now?: () => number;
};

export class LeaseLeaderElector {
  private readonly now: () => number;
  private leaderUntil = 0;
  private renewal: Promise<boolean> | undefined;

  constructor(
    private readonly config: ControllerConfig,
    private readonly client: ControllerKubernetesClient,
    clock: LeaderClock = {},
  ) {
    this.now = clock.now ?? Date.now;
  }

  isLeader() {
    return this.leaderUntil > this.now();
  }

  async acquireOrRenew() {
    if (this.renewal) return this.renewal;
    this.renewal = this.performAcquireOrRenew();
    try {
      return await this.renewal;
    } finally {
      this.renewal = undefined;
    }
  }

  private async performAcquireOrRenew() {
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const current = await this.client.getLease(this.config.leaseName);
    if (!current) {
      try {
        await this.client.replaceLease(this.config.leaseName, {
          holderIdentity: this.config.instanceId,
          leaseDurationSeconds: this.config.leaseDurationSeconds,
          acquireTime: now,
          renewTime: now,
          leaseTransitions: 0,
        });
        this.leaderUntil = nowMs + this.safeLeaseWindowMs();
        return true;
      } catch (error) {
        if (error instanceof KubernetesDependencyError && error.code === "KUBERNETES_CONFLICT") {
          this.leaderUntil = 0;
          return false;
        }
        throw error;
      }
    }

    const ownLease = current.holderIdentity === this.config.instanceId;
    const expired = leaseExpired(current, nowMs);
    if (!ownLease && !expired) {
      this.leaderUntil = 0;
      return false;
    }
    const next: LeaseRecord = {
      resourceVersion: current.resourceVersion,
      holderIdentity: this.config.instanceId,
      leaseDurationSeconds: this.config.leaseDurationSeconds,
      acquireTime: ownLease ? current.acquireTime ?? now : now,
      renewTime: now,
      leaseTransitions: Math.max(0, current.leaseTransitions ?? 0) + (ownLease ? 0 : 1),
    };
    try {
      await this.client.replaceLease(this.config.leaseName, next);
      this.leaderUntil = nowMs + this.safeLeaseWindowMs();
      return true;
    } catch (error) {
      if (error instanceof KubernetesDependencyError && error.code === "KUBERNETES_CONFLICT") {
        this.leaderUntil = 0;
        return false;
      }
      throw error;
    }
  }

  relinquish() {
    this.leaderUntil = 0;
  }

  private safeLeaseWindowMs() {
    // Stop reconciling before the API-visible lease expires. This prevents a
    // stalled leader and its successor from both mutating tenant resources.
    return Math.floor(this.config.leaseDurationSeconds * 1_000 * 0.67);
  }
}

function leaseExpired(lease: LeaseRecord, nowMs: number) {
  const renewMs = Date.parse(lease.renewTime ?? lease.acquireTime ?? "");
  const durationSeconds = lease.leaseDurationSeconds;
  if (!Number.isFinite(renewMs) || !Number.isInteger(durationSeconds) || Number(durationSeconds) < 1) {
    // A malformed lease cannot be safely stolen. An operator must repair it.
    return false;
  }
  return renewMs + Number(durationSeconds) * 1_000 < nowMs;
}
