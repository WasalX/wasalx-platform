export function allowedPlatformProxyRoute(method: string, path: string) {
  const routes: Record<string, RegExp[]> = {
    GET: [
      /^operations\/tenants\/[0-9a-f-]{36}\/connections\/[0-9a-f-]{36}\/meta-routing-review$/iu,
      /^operations\/tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/meta\/account-transitions(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/review)?$/iu,
      /^meta-deletion$/u,
      /^operations\/overview$/u,
      /^operations\/tenants$/u,
      /^metering\/tenants\/[0-9a-f-]{36}$/iu,
      /^metering\/rates$/u,
      /^meta-costs\/tenants\/[0-9a-f-]{36}$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/export$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/statements(?:\/[0-9a-f-]{36})?$/iu,
      /^tenants\/[0-9a-f-]{36}\/provisioning$/iu,
      /^waha-workers$/u,
      /^support-access\/[0-9a-f-]{36}$/iu,
      /^support-access\/[0-9a-f-]{36}\/overview$/iu,
    ],
    POST: [
      /^operations\/tenants\/[0-9a-f-]{36}\/connections\/[0-9a-f-]{36}\/meta-routing-review$/iu,
      /^operations\/tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/meta\/account-transitions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/review\/(?:prerequisites|target|completion)(?:\/resolve)?$/iu,
      /^meta-deletion\/lookup$/u,
      /^meta-deletion\/[0-9a-f-]{36}\/review$/iu,
      /^tenants$/u,
      /^tenants\/[0-9a-f-]{36}\/provisioning\/retry$/iu,
      /^tenants\/[0-9a-f-]{36}\/suspend$/iu,
      /^tenants\/[0-9a-f-]{36}\/resume$/iu,
      /^support-access$/u,
      /^support-access\/[0-9a-f-]{36}\/cancel$/iu,
      /^metering\/rates$/u,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/tariffs$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/tariffs\/[0-9a-f-]{36}\/activate$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/accounts\/[0-9a-f-]{36}\/reassess$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/statements$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/statements\/[0-9a-f-]{36}\/(?:review|preview|publish|reconcile-source|privacy-review)$/iu,
      /^meta-costs\/tenants\/[0-9a-f-]{36}\/finance-retention$/iu,
    ],
    PUT: [
      /^metering\/tenants\/[0-9a-f-]{36}\/quotas\/[A-Z_]+$/u,
    ],
    PATCH: [/^waha-workers\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/mode$/u],
  };
  return (routes[method] ?? []).some((pattern) => pattern.test(path));
}
