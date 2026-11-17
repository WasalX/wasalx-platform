import {routingStarterSupportGroupIds} from '../packages/core/src/client-routing.ts';
export type SupportQueueOrigin = "active" | "single" | null;

/**
 * Support entry queues for a new routing draft. A version without queues routes
 * nothing, so a new draft carries the queues forward from the active version;
 * with no active version and exactly one eligible queue, that queue is used.
 * Otherwise the draft stays empty and activation shows its warning.
 */
export function draftSupportQueues(input: {
  baseIds: readonly string[] | undefined;
  baseIsActive: boolean;
  activeIds: readonly string[] | undefined;
  hasActiveVersion?: boolean;
  eligibleIds: readonly string[];
}): { ids: string[]; origin: SupportQueueOrigin } {
  const hasActive = input.hasActiveVersion ?? (input.activeIds !== undefined || input.baseIsActive);
  const ids = routingStarterSupportGroupIds(hasActive ? {supportGroupIds: [...(input.activeIds ?? [])]} : undefined,input.eligibleIds);
  return {ids,origin:hasActive?"active":ids.length===1?"single":null};
}
