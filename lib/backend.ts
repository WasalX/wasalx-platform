export type PortalDataBackend="d1"|"fixture"|"control-plane";

export const SITES_PRIVATE_DEMO_MESSAGE =
  "This preview is read-only. Live operations require a connected WasalX workspace.";

export function portalDataBackend():PortalDataBackend{
  const value=process.env.PORTAL_DATA_BACKEND??"d1";
  if(value!=="d1"&&value!=="fixture"&&value!=="control-plane")throw new Error(`Unsupported PORTAL_DATA_BACKEND: ${value}`);
  return value;
}

export function isControlPlaneBackend(){return portalDataBackend()==="control-plane"}
export function isFixtureBackend(){return portalDataBackend()==="fixture"}
export function isSitesPrivateDemoBackend(){return portalDataBackend()==="d1"}

export function sitesPrivateDemoError(capability = "This operation") {
  return Object.assign(
    new Error(`${capability} is unavailable. ${SITES_PRIVATE_DEMO_MESSAGE}`),
    { status: 409, code: "SITES_PRIVATE_DEMO_READ_ONLY" },
  );
}
