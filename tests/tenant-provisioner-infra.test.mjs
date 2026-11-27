import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { assertCommercialGoAdmission } from "../services/control-api/dist/commercial-go-admission.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const projectionHash = ({ spec }) => createHash("sha256").update(JSON.stringify(canonical({
  group: spec.group, scope: spec.scope, names: spec.names, versions: spec.versions,
}))).digest("hex");

test("tenant provisioner is a separate pinned non-root health-checked image", async () => {
  const dockerfile = await read("Dockerfile.tenant-provisioner");
  const server = await read("services/tenant-provisioner/src/server.ts");
  assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /@wasalx\/tenant-provisioner build/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /:latest(?!@sha256:[a-f0-9]{64}\b)/);
  assert.match(server, /TextDecoder\("utf-8", \{ fatal: true, ignoreBOM: true \}\)/u);
});

test("TenantWorkspace CRD encodes every real isolation and readiness artifact", async () => {
  const crd = await read("infra/helm/wasalx/crds/platform.wasalx.io_tenantworkspaces.yaml");
  for (const requirement of [
    "DedicatedDatabaseAndRole",
    "DedicatedNamespaceAndCredential",
    "DedicatedPrefixAndCredential",
    "database_secret_reference",
    "search_secret_reference",
    "storage_secret_reference",
    "service_secret_reference",
    "privacy_secret_reference",
    "oidc_secret_reference",
    "configuratorImage",
    "nginxImage",
    "redisImage",
    "memcachedImage",
    "runtime_image",
    "package_version",
    "package_sha256",
    "password_login_disabled",
    "isolation_verified",
    "credentials_disabled",
    "workloads_scaled_to_zero",
    "ingress_disabled",
    "credentials_enabled",
    "workloads_ready",
    "ingress_enabled",
    "resumed_at",
  ]) {
    assert.match(crd, new RegExp(requirement));
  }
  assert.match(crd, /subresources: \{ status: \{\} \}/);
  assert.match(crd, /wasalx\.io\/contract-version: "commercial-go-v1"/u);
  assert.match(crd, /listKind: TenantWorkspaceList/u);
  assert.match(crd, /required: \[instanceId, version, image, configuratorImage, nginxImage, redisImage, memcachedImage, hostname, packageVersion, packageSha256\]/u);
  assert.equal((crd.match(/pattern: "\^\[A-Za-z0-9\._\/-\]\+@sha256:\[0-9a-f\]\{64\}\$"/gu) ?? []).length, 6);
  assert.match(crd, /rule: "self == oldSelf"/u);
  assert.match(crd, /Tenant workspace identity and configuration are immutable/u);
  assert.match(crd, /self\.request\.fencingToken >= oldSelf\.request\.fencingToken/u);
  assert.match(crd, /self\.request\.fencingToken > oldSelf\.request\.fencingToken \|\| self\.request == oldSelf\.request/u);
  assert.doesNotMatch(crd, /oldSelf\.request\.resumePhase == 'PREPARE'[\s\S]*self\.request\.resumePhase == 'PUBLISH'/u);
  assert.match(crd, /self\.request\.action == 'SUSPEND' && self\.desiredState == 'Suspended'[\s\S]*self\.request\.desiredStep == 'suspend'[\s\S]*self\.request\.idempotencyKey == 'suspend:'/u);
  assert.doesNotMatch(crd, /enum: \[[^\]]*UPGRADE/u);
  assert.doesNotMatch(crd, /password:\s*\{\s*type|apiKey:\s*\{\s*type|accessKey:\s*\{\s*type/);
});

test("CRD admission upgrades the exact schema only without live custom resources", async () => {
  const script = await read("scripts/release/apply-crds.mjs");
  const manifest = JSON.parse(await read("release/crd-contract.json"));
  assert.equal(manifest.contracts.length, 2);
  for (const contract of manifest.contracts) {
    const source = await read(contract.source);
    const document = parseYaml(source);
    assert.equal(createHash("sha256").update(source).digest("hex"), contract.sourceSha256);
    assert.equal(projectionHash(document), contract.projectionSha256);
    assert.match(source, new RegExp(`wasalx\\.io/contract-sha256: "${contract.projectionSha256}"`, "u"));
    assert.equal(document.spec.names.listKind, contract.listKind);
  }
  assert.deepEqual(manifest.contracts.map(({ name }) => name), [
    "tenantworkspaces.platform.wasalx.io",
    "workspaceproviderresources.providers.wasalx.io",
  ]);
  assert.match(script, /expectedContractIdentities/u);
  assert.match(script, /JSON\.stringify\(identities\) !== JSON\.stringify\(expectedContractIdentities\)/u);
  assert.match(script, /major === 1 && minor < 30/u);
  assert.match(script, /"diff", "--server-side=true"/u);
  assert.match(script, /--raw=\/apis\/\$\{group\}\/\$\{version\}\/\$\{plural\}\?limit=1/u);
  assert.match(script, /"--dry-run=server"[\s\S]*"-o", "json"/u);
  assert.match(script, /projectionHash\(dryRun\) !== item\.projectionSha256/u);
  assert.match(script, /coupled CRD transition/u);
  assert.match(script, /"apply", "--server-side=true"/u);
  assert.match(script, /"wait", "--for=condition=Established"/u);
  assert.match(script, /"wait", "--for=condition=NamesAccepted"/u);
  assert.match(script, /candidateSha/);
  assert.match(script, /clusterUid/);
  assert.doesNotMatch(script, /force-conflicts/u);
});

test("Helm gives the provisioner only a projected namespaced custom-resource token", async () => {
  const template = await read("infra/helm/wasalx/templates/tenant-provisioner.yaml");
  const network = await read("infra/helm/wasalx/templates/networkpolicy.yaml");
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const workspaceProvider = await read("infra/helm/wasalx/templates/workspace-provider.yaml");
  const values = parseYaml(await read("infra/helm/wasalx/values.yaml"));
  const schema = JSON.parse(await read("infra/helm/wasalx/values.schema.json"));
  const terraform = await read("infra/terraform/main.tf");
  const migrate = await read("services/control-api/src/migrate.ts");
  assert.match(template, /automountServiceAccountToken: false/);
  assert.match(template, /serviceAccountToken:/);
  assert.match(template, /expirationSeconds: 3600/);
  assert.match(template, /fsGroup: 1000/);
  assert.match(template, /resources: \[tenantworkspaces\]/);
  assert.match(template, /resources: \[tenantworkspaces\/status\]/);
  assert.match(template, /name: wasalx-workspace-status-writer/);
  assert.doesNotMatch(template, /kind: ClusterRole/);
  assert.doesNotMatch(template, /resources: \[(?:secrets|pods|deployments|namespaces)\]/);
  assert.doesNotMatch(template, /verbs: \["?\*"?\]/);
  assert.match(network, /app\.kubernetes\.io\/name: wasalx-tenant-provisioner/);
  assert.match(config, /PROVISIONING_DRIVER_URL/);
  for (const name of [
    "WASALX_ZAMMAD_PACKAGE_VERSION",
    "WASALX_ZAMMAD_PACKAGE_SHA256",
    "ZAMMAD_IMAGE_BY_VERSION_JSON",
    "ZAMMAD_CONFIGURATOR_IMAGE",
    "ZAMMAD_NGINX_IMAGE",
    "ZAMMAD_REDIS_IMAGE",
    "ZAMMAD_MEMCACHED_IMAGE",
  ]) assert.match(config, new RegExp(name));
  assert.doesNotMatch(template, /WASALX_ZAMMAD_PACKAGE_(?:VERSION|SHA256)/u);
  assert.doesNotMatch(config, /PROVISIONING_DRIVER_JWT_SECRET:/);
  assert.match(config, /resources: \[tenantworkspaces\], verbs: \[list\]/u);
  assert.match(config, /resources: \[workspaceproviderresources\], verbs: \[list\]/u);
  assert.match(config, /kind: ClusterRole[\s\S]*resources: \[customresourcedefinitions\][\s\S]*resourceNames: \[tenantworkspaces\.platform\.wasalx\.io, workspaceproviderresources\.providers\.wasalx\.io\][\s\S]*verbs: \[get\]/u);
  assert.match(config, /hook-weight: "-7"[\s\S]*args: \["admit-commercial-go"\][\s\S]*hook-weight: "-5"[\s\S]*args: \["migrate", "--path", "\/app\/migrations"\]/u);
  assert.match(config, /activeDeadlineSeconds: 120[\s\S]*args: \["admit-commercial-go"\][\s\S]*activeDeadlineSeconds: 720[\s\S]*args: \["migrate"/u);
  assert.match(config, /component: commercial-go-admission[\s\S]*securityContext: \{\{ toYaml \.Values\.podSecurityContext \| nindent 8 \}\}[\s\S]*name: commercial-go-admission/u);
  assert.match(workspaceProvider, /kind: Job[\s\S]*activeDeadlineSeconds: 720/u);
  assert.deepEqual(values.podSecurityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.ok(schema.required.includes("podSecurityContext"));
  assert.deepEqual(schema.properties.podSecurityContext.required, ["runAsNonRoot", "runAsUser", "runAsGroup", "fsGroup", "fsGroupChangePolicy", "seccompProfile"]);
  assert.match(terraform, /podSecurityContext\s*= \{ runAsNonRoot = true, runAsUser = 1000, runAsGroup = 1000, fsGroup = 1000, fsGroupChangePolicy = "OnRootMismatch"/u);
  assert.match(migrate, /connectionTimeoutMillis: 10_000/u);
  assert.match(migrate, /SET lock_timeout = '30s'/u);
  assert.match(migrate, /SET statement_timeout = '10min'/u);
  assert.match(migrate, /pg_try_advisory_lock/u);
  assert.match(migrate, /const exactPrefix = realApplied\.every/u);
  assert.match(migrate, /marker\.checksum_sha256 !== manifestChecksum/u);
  assert.doesNotMatch(config, /initContainers:/u);
  assert.match(config, /serviceAccountToken: \{ path: token,[\s\S]*expirationSeconds: 600/u);
  assert.match(network, /wasalx-migration-egress[\s\S]*hook-weight: "-8"[\s\S]*kubernetes\.io\/metadata\.name: kube-system[\s\S]*concat \.Values\.apiAllowedEgressCidrs \.Values\.provisioner\.allowedEgressCidrs/u);
});

test("Commercial-GO admission fails closed on database or Kubernetes tenant residue", async () => {
  const admissionSource = await read("services/control-api/src/commercial-go-admission.ts");
  assert.match(admissionSource, /expectedCrdContractIdentities/u);
  assert.match(admissionSource, /JSON\.stringify\(identities\) !== JSON\.stringify\(expectedCrdContractIdentities\)/u);
  const database = (tenantCount = "0", applied = false) => ({
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ migrations: "wasalx_schema_migrations", tenants: "tenants" }] };
      if (sql.includes("wasalx_schema_migrations WHERE")) return { rows: [{ applied }] };
      if (sql.includes("count(*)")) return { rows: [{ count: tenantCount }] };
      assert.fail(`unexpected query: ${sql}`);
    },
  });
  const options = {
    kubernetesApiUrl: new URL("https://kubernetes.example.test"),
    namespace: "wasalx",
    token: "trusted-token-value",
  };
  const crds = new Map(await Promise.all([
    "infra/helm/wasalx/crds/platform.wasalx.io_tenantworkspaces.yaml",
    "infra/helm/wasalx/crds/providers.wasalx.io_workspaceproviderresources.yaml",
  ].map(async (path) => {
    const document = parseYaml(await read(path));
    document.metadata.uid = crypto.randomUUID();
    document.metadata.resourceVersion = "1";
    document.metadata.generation = 1;
    document.status = { storedVersions: ["v1alpha1"], conditions: [
      { type: "NamesAccepted", status: "True" },
      { type: "Established", status: "True" },
    ] };
    return [document.metadata.name, document];
  })));
  const crd = (name) => structuredClone(crds.get(name));
  const list = (url, items = [], continuation = "") => {
    const provider = new URL(url).pathname.includes("workspaceproviderresources");
    return {
      apiVersion: provider ? "providers.wasalx.io/v1alpha1" : "platform.wasalx.io/v1alpha1",
      kind: provider ? "WorkspaceProviderResourceList" : "TenantWorkspaceList",
      metadata: { continue: continuation },
      items,
    };
  };
  let requests = 0;
  const emptyKubernetes = async (url) => {
    requests += 1;
    const name = new URL(url).pathname.split("/").at(-1);
    if (name?.includes(".wasalx.io")) return Response.json(crd(name));
    return Response.json(list(url));
  };
  await assertCommercialGoAdmission(database(), emptyKubernetes, options);
  assert.equal(requests, 4);
  await assert.rejects(
    () => assertCommercialGoAdmission(database("1"), emptyKubernetes, options),
    /clean tenant database/u,
  );
  await assert.rejects(
    () => assertCommercialGoAdmission(database(), async (url) => {
      const name = new URL(url).pathname.split("/").at(-1);
      return name?.includes(".wasalx.io")
        ? Response.json(crd(name))
        : Response.json(list(url, [{}]));
    }, options),
    /zero existing tenant resources/u,
  );
  requests = 0;
  await assertCommercialGoAdmission(database("1", true), emptyKubernetes, options);
  assert.equal(requests, 4);
  await assertCommercialGoAdmission(database("1", true), async (url) => {
    const name = new URL(url).pathname.split("/").at(-1);
    return name?.includes(".wasalx.io") ? Response.json(crd(name)) : Response.json(list(url, [{}], "next-page"));
  }, options);
  await assert.rejects(
    () => assertCommercialGoAdmission(database(), async (url) => {
      const name = new URL(url).pathname.split("/").at(-1);
      if (!name?.includes(".wasalx.io")) return Response.json(list(url));
      const document = crd(name);
      document.metadata.annotations["wasalx.io/contract-version"] = "stale";
      return Response.json(document);
    }, options),
    /contract is stale/u,
  );
  await assert.rejects(
    () => assertCommercialGoAdmission(database(), async (url) => {
      const name = new URL(url).pathname.split("/").at(-1);
      if (!name?.includes(".wasalx.io")) return Response.json(list(url));
      const document = crd(name);
      if (name.startsWith("tenantworkspaces")) {
        delete document.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.zammad["x-kubernetes-validations"];
      }
      return Response.json(document);
    }, options),
    /contract is stale/u,
  );
  await assert.rejects(
    () => assertCommercialGoAdmission(database(), emptyKubernetes, { ...options, kubernetesApiUrl: new URL("http://kubernetes.example.test") }),
    /configuration is invalid/u,
  );
});

test("Compose exposes only an opt-in fail-closed Kubernetes profile", async () => {
  const compose = await read("compose.full.yaml");
  const base = await read("compose.yaml");
  assert.match(compose, /tenant-provisioner:\r?\n\s+profiles: \[tenant-provisioning\]/);
  assert.match(compose, /Dockerfile\.tenant-provisioner/);
  assert.match(compose, /tenant-workspace-controller:\r?\n\s+profiles: \[tenant-provisioning\]/);
  assert.match(compose, /Dockerfile\.tenant-workspace-controller/);
  assert.match(compose, /unconfigured-provider-token/);
  assert.match(compose, /unconfigured-token/);
  assert.match(compose, /unconfigured-ca\.crt/);
  assert.doesNotMatch(base, /^\s{2}tenant-provisioner:/m);
  assert.doesNotMatch(compose, /docker\.sock/);
});

test("controller has separate image, leader lease, label enforcement, and no Secret API permission", async () => {
  const dockerfile = await read("Dockerfile.tenant-workspace-controller");
  const template = await read("infra/helm/wasalx/templates/tenant-workspace-controller.yaml");
  assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /dist\/controller-bootstrap\.js/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(template, /resources: \[leases\]/);
  assert.match(template, /resources: \[services, persistentvolumeclaims, configmaps\]/);
  assert.match(template, /resources: \[externalsecrets\]/);
  assert.match(template, /kind: ValidatingAdmissionPolicy/);
  assert.match(template, /monotonic request-bound ownership annotations/u);
  assert.match(template, /int\(object\.metadata\.annotations\['wasalx\.io\/fencing-token'\]\) >= int\(oldObject\.metadata\.annotations\['wasalx\.io\/fencing-token'\]\)/u);
  assert.match(template, /Workspace controller mutations require immutable tenant ownership labels/);
  assert.match(template, /oldObject\.metadata\.labels\['wasalx\.io\/tenant'\]/);
  assert.match(template, /serviceAccountToken:/);
  assert.match(template, /fsGroup: 1000/);
  assert.match(template, /WORKSPACE_PROVIDER_TOKEN_FILE/);
  assert.match(template, /\{\{- with \.Values\.provisioner\.controller\.zammadDisplayTimeZone \}\}\s*- \{ name: WASALX_ZAMMAD_DISPLAY_TIMEZONE, value: \{\{ \. \| quote \}\} \}\s*\{\{- end \}\}/u);
  assert.doesNotMatch(template, /ZAMMAD_(?:IMAGE_BY_VERSION_JSON|CONFIGURATOR_IMAGE|NGINX_IMAGE|REDIS_IMAGE|MEMCACHED_IMAGE)/u);
  assert.doesNotMatch(template, /resources: \[secrets\]/);
  assert.doesNotMatch(template, /pods\/exec|kind: ClusterRole|verbs: \["?\*"?\]/);
});
