import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { createReplaceableRequestController } from "../lib/meta-capability-request.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("portal publishes a tenant-authorized, no-store official Meta Groups BFF", async () => {
  const routes = [
    "app/api/connections/[id]/meta/capabilities/route.ts",
    "app/api/connections/[id]/meta/credentials/route.ts",
    "app/api/connections/[id]/meta/groups/route.ts",
    "app/api/connections/[id]/meta/groups/[groupId]/route.ts",
    "app/api/connections/[id]/meta/groups/[groupId]/invite-link/route.ts",
    "app/api/connections/[id]/meta/groups/[groupId]/invite-link/reset/route.ts",
  ];
  await Promise.all(routes.map((path) => access(new URL(`../${path}`, import.meta.url))));
  const proxy = await read("app/api/connections/_meta-groups.ts");
  assert.match(proxy, /authenticatePortalRequest\(request, permission\)/);
  assert.match(proxy, /action === "capability"[\s\S]*"connection:read"/);
  assert.match(proxy, /action === "invite-link"[\s\S]*"group:read"/);
  assert.match(proxy, /"group:write"/);
  assert.match(proxy, /requireIdempotencyKey\(request\)/);
  assert.match(proxy, /Cache-Control.*no-store/);
  assert.match(proxy, /cannot be simulated/);
});

test("connection wizard permits direct Meta with credentials and optional Groups consent", async () => {
  const source = await readTenantPortalSource();
  for (const key of [
    "tenant.setup.providers.metaMeta",
    "tenant.setup.review.metaTitle",
    "tenant.setup.review.metaBody",
  ]) assert.match(source, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(englishTenantMessages["tenant.setup.providers.metaMeta"], /Official one-to-one messaging/u);
  assert.match(englishTenantMessages["tenant.setup.review.metaBody"], /verifies the number and webhook/u);
  assert.match(englishTenantMessages["tenant.setup.review.metaBody"], /one-to-one messaging/u);
  assert.match(englishTenantMessages["tenant.setup.review.metaBody"], /Official groups remain unavailable unless this number later passes a separate live eligibility check/u);
  assert.match(source, /type="password"/);
  assert.match(source, /setMetaAccessToken\(""\)/);
  assert.match(source, /tenant\.setup\.meta\.tokenHelp/u);
  assert.match(englishTenantMessages["tenant.setup.meta.tokenHelp"], /never writes the token to the application database or browser storage/u);
  assert.doesNotMatch(source, /Meta Groups connector is not enabled/);

  const createRoute = await read("app/api/connections/route.ts");
  assert.match(createRoute, /Official Meta connections require the managed service/);
  assert.doesNotMatch(createRoute, /!body\.eligibilityAccepted/);
  assert.match(source, /provider === "waha" && !accepted/);
  assert.match(source, /eligibilityVersion: provider === "meta" && accepted/);
  assert.match(englishTenantMessages["tenant.setup.review.metaGroupsAccept"], /Optional: enable official Groups/);
  assert.match(createRoute, /eligibilityAccepted/);
  assert.match(createRoute, /phoneNumberId/);
  assert.match(createRoute, /wabaId/);
  assert.match(createRoute, /accessToken/);
});

test("later Groups opt-in uses existing sync and pins the consent in the retry intent", async () => {
  const source = await readTenantPortalSource();
  assert.match(source, /action === "sync" && detail\?\.provider === "META" && !detail\.disclosure_version && metaGroupsAccepted/);
  assert.match(source, /body: JSON\.stringify\(intent\.body\)/);
  assert.match(source, /capability\?\.state === "CONSENT_REQUIRED"/);
  assert.match(source, /operationPending \|\| actionPending \|\| Boolean\(retryIntent\)/);
  const bff = await read("app/api/connections/_lifecycle.ts");
  assert.match(bff, /action === "groups\/sync"/);
  assert.match(bff, /eligibilityAccepted: input\.eligibilityAccepted, eligibilityVersion: input\.eligibilityVersion/);
});

test("existing Meta connections can replace an expired token without recreating the connection", async () => {
  const source = await readTenantPortalSource();
  const rotation = source.slice(
    source.indexOf("function MetaCredentialRotation("),
    source.indexOf("type MetaCapabilityView"),
  );
  const route = await read("app/api/connections/[id]/meta/credentials/route.ts");
  const bridge = await read("lib/control-plane-data.ts");
  for (const key of [
    "tenant.connection.metaCredential.title",
    "tenant.connection.metaCredential.help",
    "tenant.connection.metaCredential.replace",
    "tenant.connection.metaCredential.success",
  ]) assert.match(source, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="new-password"/u);
  assert.match(source, /setAccessToken\(""\)/u);
  assert.match(route, /authenticatePortalRequest\(request, "connection:write"\)/u);
  assert.match(route, /request\.headers\.get\("idempotency-key"\)/u);
  assert.match(route, /Cache-Control[\s\S]*no-store/u);
  assert.match(bridge, /rotateMetaCredential[\s\S]*"idempotency-key": idempotencyKey/u);
  assert.match(rotation, /const \[attemptToken, setAttemptToken\] = useState<string \| null>\(null\)/u);
  assert.match(rotation, /const token = attemptToken \?\? accessToken[\s\S]*setAttemptToken\(token\)/u);
  assert.match(rotation, /body: JSON\.stringify\(\{ accessToken: token \}\)/u);
  assert.match(rotation, /disabled=\{pending \|\| attemptToken !== null\}/u);
  assert.match(rotation, /const resetAttempt = \(\) => \{[\s\S]*setAccessToken\(""\)[\s\S]*setAttemptToken\(null\)[\s\S]*setIdempotencyKey\(crypto\.randomUUID\(\)\)[\s\S]*draftChanged\(false\)/u);
  assert.match(rotation, /attemptToken !== null[\s\S]*tenant\.actions\.retrySameRequest/u);
  const failurePath = rotation.slice(rotation.indexOf("} catch (requestError)"), rotation.indexOf("} finally"));
  assert.doesNotMatch(failurePath, /setAttemptToken|setIdempotencyKey/u);
  assert.match(source, /setIdempotencyKey\(crypto\.randomUUID\(\)\)/u);
  assert.match(source, /"idempotency-key": idempotencyKey/u);
  assert.match(source, /\["STAGED", "QUEUED", "RUNNING", "FAILED_RETRYABLE"\]/u);
  assert.match(englishTenantMessages["tenant.connection.metaCredential.help"], /never stores it in the application database or browser storage/u);
});

test("official group creation UI stays fail closed until a live provider probe succeeds", async () => {
  const source = await readTenantPortalSource();
  for (const key of [
    "tenant.connection.officialGroups.body",
    "tenant.connection.officialGroups.unverifiedBody",
    "tenant.connection.officialGroups.recheck",
    "tenant.connection.officialGroups.requirements",
    "tenant.connection.officialGroups.constraintsLabel",
    "tenant.connection.officialGroups.newAccepted",
    "tenant.actions.retrySameRequest",
  ]) assert.match(source, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(source, /if \(!capability\?\.eligible \|\| !canConfigure \|\| !subject\.trim\(\)\) return/u);
  assert.match(source, /capability\?\.eligible \? \(/u);
  assert.match(englishTenantMessages["tenant.connection.officialGroups.unverifiedBody"], /No group request can be sent until eligibility is confirmed/u);
  assert.equal(englishTenantMessages["tenant.actions.retrySameRequest"], "Retry same request");
  assert.match(englishTenantMessages["tenant.connection.officialGroups.newAccepted"], /request accepted/u);
  assert.equal(englishTenantMessages["tenant.connection.officialGroups.constraintsLabel"], "Official group requirements");

  const bridge = await read("lib/control-plane-data.ts");
  assert.match(bridge, /getMetaGroupsCapability/);
  assert.match(bridge, /createMetaOfficialGroup/);
  assert.match(bridge, /getMetaGroupInviteLink/);
  assert.match(bridge, /resetMetaGroupInviteLink/);
  assert.match(bridge, /updateMetaOfficialGroup/);
});

test("official Meta capability request aborts the held request on view cleanup", () => {const requests=createReplaceableRequestController(),first=requests.begin();assert.equal(first.signal.aborted,false);const retry=requests.begin();assert.equal(first.signal.aborted,true);assert.equal(retry.signal.aborted,false);requests.abort();assert.equal(retry.signal.aborted,true);const after=requests.begin();requests.finish(after);assert.equal(after.signal.aborted,false);requests.abort();assert.equal(after.signal.aborted,false);});
