import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const boundaryMigration = "0133_commercial_go_boundaries.sql";
const contractVersion = "commercial-go-v1";
const maximumKubernetesResponseBytes = 256_000;
const digestPattern = /^[0-9a-f]{64}$/u;
const expectedCrdContractIdentities = [
  ["tenantworkspaces.platform.wasalx.io", "tenantworkspaces.platform.wasalx.io", "platform.wasalx.io/v1alpha1", "TenantWorkspaceList", "infra/helm/wasalx/crds/platform.wasalx.io_tenantworkspaces.yaml"],
  ["workspaceproviderresources.providers.wasalx.io", "workspaceproviderresources.providers.wasalx.io", "providers.wasalx.io/v1alpha1", "WorkspaceProviderResourceList", "infra/helm/wasalx/crds/providers.wasalx.io_workspaceproviderresources.yaml"],
];

type QueryClient = Pick<Client, "query">;
type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

type CrdContract = {
  name: string;
  resource: string;
  apiVersion: string;
  listKind: string;
  projectionSha256: string;
};

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as JsonObject)[key])]))
    : value;

const crdProjectionSha256 = (document: JsonObject) => {
  const spec = asObject(document.spec);
  if (!spec || (spec.preserveUnknownFields !== undefined && spec.preserveUnknownFields !== false)) {
    throw new Error("Commercial-GO Kubernetes CRD spec is stale");
  }
  const conversion = asObject(spec.conversion);
  if (spec.conversion !== undefined && (!conversion || conversion.strategy !== "None" || Object.keys(conversion).length !== 1)) {
    throw new Error("Commercial-GO Kubernetes CRD conversion is stale");
  }
  return createHash("sha256").update(JSON.stringify(canonical({
    group: spec.group,
    scope: spec.scope,
    names: spec.names,
    versions: spec.versions,
  }))).digest("hex");
};

const loadCrdContracts = async () => {
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(resolve("release/crd-contract.json"), "utf8")); }
  catch { throw new Error("Commercial-GO CRD contract manifest is unavailable"); }
  const document = asObject(manifest);
  const entries = Array.isArray(document?.contracts) ? document.contracts : [];
  if (document?.schemaVersion !== 1 || entries.length !== 2) throw new Error("Commercial-GO CRD contract manifest is invalid");
  const contracts = entries.map((value): CrdContract => {
    const entry = asObject(value);
    if (!entry || typeof entry.name !== "string" || typeof entry.resource !== "string" ||
        typeof entry.apiVersion !== "string" || typeof entry.listKind !== "string" ||
        typeof entry.source !== "string" ||
        typeof entry.projectionSha256 !== "string" || !digestPattern.test(entry.projectionSha256)) {
      throw new Error("Commercial-GO CRD contract manifest is invalid");
    }
    return {
      name: entry.name,
      resource: entry.resource,
      apiVersion: entry.apiVersion,
      listKind: entry.listKind,
      projectionSha256: entry.projectionSha256,
    };
  });
  const identities = entries.map((value) => {
    const entry = value as JsonObject;
    return [entry.name, entry.resource, entry.apiVersion, entry.listKind, entry.source];
  });
  if (JSON.stringify(identities) !== JSON.stringify(expectedCrdContractIdentities)) {
    throw new Error("Commercial-GO CRD contract manifest identities are invalid");
  }
  return contracts;
};

const readBoundedJson = async (response: Response) => {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximumKubernetesResponseBytes)) {
    throw new Error("Commercial-GO Kubernetes response is too large");
  }
  if (!response.body) throw new Error("Commercial-GO Kubernetes response is invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumKubernetesResponseBytes) {
      await reader.cancel();
      throw new Error("Commercial-GO Kubernetes response is too large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown; }
  catch { throw new Error("Commercial-GO Kubernetes response is invalid"); }
};

const kubernetesJson = async (
  fetcher: typeof fetch,
  options: { kubernetesApiUrl: URL; token: string },
  path: string,
) => {
  const response = await fetcher(new URL(path, options.kubernetesApiUrl), {
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Commercial-GO admission could not verify the Kubernetes contract");
  return readBoundedJson(response);
};

const assertCrdContract = (value: unknown, contract: CrdContract) => {
  const document = asObject(value);
  const metadata = asObject(document?.metadata);
  const status = asObject(document?.status);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const accepted = (type: string) => conditions.some((condition) => {
    const item = asObject(condition);
    return item?.type === type && item.status === "True";
  });
  if (
    document?.apiVersion !== "apiextensions.k8s.io/v1" || document.kind !== "CustomResourceDefinition" ||
    metadata?.name !== contract.name || metadata.deletionTimestamp !== undefined ||
    asObject(metadata.annotations)?.["wasalx.io/contract-version"] !== contractVersion ||
    asObject(metadata.annotations)?.["wasalx.io/contract-sha256"] !== contract.projectionSha256 ||
    !accepted("Established") || !accepted("NamesAccepted") ||
    JSON.stringify(status?.storedVersions) !== JSON.stringify(["v1alpha1"]) ||
    !document || crdProjectionSha256(document) !== contract.projectionSha256
  ) throw new Error(`Commercial-GO Kubernetes ${contract.name} contract is stale`);
};

export async function assertCommercialGoAdmission(
  client: QueryClient,
  fetcher: typeof fetch,
  options: { kubernetesApiUrl: URL; namespace: string; token: string },
) {
  if (
    options.kubernetesApiUrl.protocol !== "https:" || options.kubernetesApiUrl.username || options.kubernetesApiUrl.password ||
    options.kubernetesApiUrl.search || options.kubernetesApiUrl.hash ||
    options.namespace.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(options.namespace) ||
    options.token.length < 16 || options.token.length > 16_384 || /[\p{Cc}\p{Cf}]/u.test(options.token)
  ) throw new Error("Commercial-GO Kubernetes configuration is invalid");

  const crdContracts = await loadCrdContracts();
  for (const contract of crdContracts) {
    const document = await kubernetesJson(
      fetcher,
      options,
      `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${contract.name}`,
    );
    assertCrdContract(document, contract);
  }

  const relations = await client.query<{ migrations: string | null; tenants: string | null }>(
    "SELECT to_regclass('public.wasalx_schema_migrations')::text AS migrations,to_regclass('public.tenants')::text AS tenants",
  );
  let boundaryApplied = false;
  if (relations.rows[0]?.migrations) {
    const applied = await client.query<{ applied: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM public.wasalx_schema_migrations WHERE name=$1) AS applied",
      [boundaryMigration],
    );
    boundaryApplied = applied.rows[0]?.applied === true;
  }
  if (!boundaryApplied && relations.rows[0]?.tenants) {
    const tenants = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM public.tenants");
    if (tenants.rows[0]?.count !== "0") throw new Error("Commercial-GO admission requires a clean tenant database");
  }
  for (const contract of crdContracts) {
    const slash = contract.apiVersion.indexOf("/");
    const group = contract.apiVersion.slice(0, slash);
    const version = contract.apiVersion.slice(slash + 1);
    const plural = contract.resource.slice(0, contract.resource.indexOf("."));
    const url = new URL(
      `/apis/${group}/${version}/namespaces/${encodeURIComponent(options.namespace)}/${plural}?limit=1`,
      options.kubernetesApiUrl,
    );
    const result = await kubernetesJson(fetcher, options, url.pathname + url.search);
    const list = asObject(result);
    const continuation = asObject(list?.metadata)?.continue;
    if (list?.apiVersion !== contract.apiVersion || list.kind !== contract.listKind || !Array.isArray(list.items) ||
        (continuation !== undefined && typeof continuation !== "string") || (!list.items.length && continuation)) {
      throw new Error("Commercial-GO Kubernetes inventory response is invalid");
    }
    if (!boundaryApplied && list.items.length !== 0) {
      throw new Error("Commercial-GO admission requires zero existing tenant resources");
    }
  }
}

export async function runCommercialGoAdmission(environment: NodeJS.ProcessEnv = process.env) {
  const connectionString = environment.DATABASE_ADMIN_URL ?? environment.DATABASE_URL;
  const apiUrl = environment.KUBERNETES_API_URL;
  const namespace = environment.PROVISIONING_WORKSPACE_NAMESPACE;
  const tokenFile = environment.KUBERNETES_BEARER_TOKEN_FILE;
  if (!connectionString || !apiUrl || !namespace || !tokenFile) {
    throw new Error("Commercial-GO admission configuration is incomplete");
  }
  let kubernetesApiUrl: URL;
  try { kubernetesApiUrl = new URL(apiUrl); }
  catch { throw new Error("Commercial-GO Kubernetes API URL is invalid"); }
  const token = (await readFile(tokenFile, "utf8")).trim();
  const client = new Client({ connectionString, application_name: "wasalx-commercial-go-admission" });
  await client.connect();
  try {
    await assertCommercialGoAdmission(client, fetch, {
      kubernetesApiUrl,
      namespace,
      token,
    });
  } finally {
    await client.end();
  }
}
