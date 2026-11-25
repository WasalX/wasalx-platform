import { readFileSync } from "node:fs";

// The tenant portal shell, its shared UI helpers, and the views it loads on demand (#183).
export const tenantPortalFiles = ["app/WasalXApp.tsx", "app/tenant-ui.tsx", "app/ConnectionDetail.tsx", "app/Groups.tsx", "app/TenantSettings.tsx", "app/Rules.tsx", "app/Deliveries.tsx", "app/Audit.tsx", "app/TeamAccess.tsx", "app/MetaCostDisclosure.tsx"];

export function readTenantPortalSource() {
  return tenantPortalFiles.map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).join("\n");
}
