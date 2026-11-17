import type { MessageKey } from "./i18n/messages/index.ts";

export const TENANT_VIEW_TITLES: Record<string, readonly [MessageKey, MessageKey]> = {
  inbox: ["inbox.title", "inbox.description"],
  overview: ["tenant.title.overview", "tenant.description.overview"],
  connections: ["tenant.title.connections", "tenant.description.connections"],
  groups: ["tenant.title.groups", "tenant.description.groups"],
  rules: ["tenant.title.rules", "tenant.description.rules"],
  automation: ["tenant.title.automation", "tenant.description.automation"],
  plugins: ["tenant.title.plugins", "tenant.description.plugins"],
  routing: ["tenant.title.routing", "tenant.description.routing"],
  cases: ["tenant.title.cases", "tenant.description.cases"],
  deliveries: ["tenant.title.deliveries", "tenant.description.deliveries"],
  team: ["tenant.title.team", "tenant.description.team"],
  support: ["tenant.title.support", "tenant.description.support"],
  audit: ["tenant.title.audit", "tenant.description.audit"],
  settings: ["tenant.title.settings", "tenant.description.settings"],
};

export function tenantViewTitle(view: string | undefined) {
  return TENANT_VIEW_TITLES[view ?? ""] ?? TENANT_VIEW_TITLES.overview!;
}
