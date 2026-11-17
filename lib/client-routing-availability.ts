import type { ClientRoutingDefinition } from "../packages/core/src/client-routing";

type Queue = { id: string; name: string; active: boolean; serviceIdentityCanCreate: boolean };
type QueueProblem = "unavailable" | "inactive" | "noServiceAccess";

/** Inspect every stored queue reference without changing the immutable definition. */
export function clientRoutingQueueWarnings(definition: ClientRoutingDefinition, groups: readonly Queue[]) {
  const references = new Set([
    ...(definition.supportGroupIds ?? []),
    definition.fallback.zammadGroupId,
    ...definition.clients.flatMap(client => [client.zammadGroupId, ...(client.escalationGroupId ? [client.escalationGroupId] : [])]),
  ]);
  const catalog = new Map(groups.map(group => [group.id, group]));
  return [...references].flatMap(id => {
    const queue = catalog.get(id);
    const reasons: QueueProblem[] = queue
      ? [...(!queue.active ? ["inactive" as const] : []), ...(!queue.serviceIdentityCanCreate ? ["noServiceAccess" as const] : [])]
      : ["unavailable"];
    return reasons.length ? [{ id, name: queue?.name, reasons }] : [];
  });
}
