import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { connectionIsReady } from "../lib/connection-readiness.ts";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("connection drawer refresh propagates negative and positive worker readiness to its catalog row", async () => {
  const source = await read("app/WasalXApp.tsx");
  assert.match(source, /worker_ready\?: boolean \| null/);
  assert.match(source, /worker_ready: detail\.worker_ready \?\? false/);
  assert.match(source, /setLiveData\(result\.data\);\s*setConnectionOverrides\(\{\}\)/);
  assert.match(source, /const reconcileConnection = useCallback\(\(detail: ConnectionDetailRow\) => \{\s*dashboardLoadFence\.current\.invalidate\(\)/);
});

test("Meta drawer refresh clears stale catalog readiness and adopts a newly processed current-session message", async () => {
  const source = await read("app/WasalXApp.tsx");
  const ast = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const find = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "reconcileConnection") callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, find);
  };
  find(ast);
  assert.ok(callback);
  const emitted = ts.transpileModule(`const reconcile = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  let overrides = { unrelated: { state: "PAUSED" } }, invalidations = 0;
  const reconcile = new Function("dashboardLoadFence", "setConnectionOverrides", `${emitted}\nreturn reconcile;`)(
    { current: { invalidate: () => invalidations++ } }, (update) => { overrides = update(overrides); },
  );
  const stamp = "2026-10-20T09:00:00Z", later = "2026-10-20T09:01:00Z";
  const catalog = { id: "meta", name: "Synthetic Meta", provider: "META", state: "WORKING", provider_session_state: "WORKING", provider_state: "AVAILABLE",
    last_heartbeat_at: stamp, webhook_state: "ACTIVE", webhook_admission_opened_at: stamp, last_provider_event_at: later,
    last_processed_provider_message_at: stamp, meta_routing_configuration_ready: true, meta_routing_reason: null };
  const current = () => ({ ...catalog, ...overrides.meta });
  assert.equal(connectionIsReady(current()), true);
  reconcile({ ...catalog, meta_routing_configuration_ready: false, meta_routing_reason: "NEGATIVE_PENDING", last_processed_provider_message_at: null, webhook_admission_opened_at: null });
  assert.equal(connectionIsReady(current()), false);
  assert.equal(current().meta_routing_reason, "NEGATIVE_PENDING");
  assert.equal(current().last_processed_provider_message_at, null);
  assert.equal(current().webhook_admission_opened_at, null);
  reconcile({ ...catalog, meta_routing_configuration_ready: undefined, meta_routing_reason: undefined, last_processed_provider_message_at: undefined });
  assert.equal(current().meta_routing_configuration_ready, false);
  assert.equal(current().meta_routing_reason, null);
  assert.equal(current().last_processed_provider_message_at, null);
  reconcile({ ...catalog, webhook_admission_opened_at: later });
  assert.equal(connectionIsReady(current()), false, "An older processed message does not verify the new session");
  reconcile({ ...catalog, webhook_admission_opened_at: later, last_processed_provider_message_at: later });
  assert.equal(connectionIsReady(current()), true);
  assert.equal(current().last_provider_event_at, later, "Raw callback time remains a separate display value");
  assert.deepEqual(overrides.unrelated, { state: "PAUSED" });
  assert.equal(invalidations, 4);
});

function assertLocalizedCopy(source, dictionary, key, copy) {
  assert.ok(source.includes(`"${key}"`), `missing translation key ${key}`);
  assert.ok(
    dictionary.includes(`${JSON.stringify(key)}: ${JSON.stringify(copy)}`),
    `missing English copy for ${key}`,
  );
}

test("portal exposes the complete durable WAHA lifecycle route surface", async () => {
  const routes = [
    "app/api/connections/[id]/start/route.ts",
    "app/api/connections/[id]/restart/route.ts",
    "app/api/connections/[id]/pause/route.ts",
    "app/api/connections/[id]/disconnect/route.ts",
    "app/api/connections/[id]/groups/sync/route.ts",
  ];
  await Promise.all(
    routes.map((path) => access(new URL(`../${path}`, import.meta.url))),
  );

  const helper = await read("app/api/connections/_lifecycle.ts");
  assert.match(helper, /authenticatePortalRequest\(request, permission\)/);
  assert.match(helper, /status: 202/);
  assert.match(helper, /action === "disconnect"/);
  assert.match(helper, /input\.confirmation !== "DISCONNECT"/);
  assert.match(helper, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(helper, /connectionLifecycle\(/);
});

test("linked groups refresh automatically while Meta also permits explicit first opt-in", async () => {
  const [source, english, arabic] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  assert.match(source, /latest_operation_type \?\? ""\)\.toUpperCase\(\) === "SYNC_GROUPS"/u);
  assert.match(source, /operationState === "FAILED_TERMINAL"/u);
  assert.match(source, /\{syncRecoveryNeeded \? \(/u);
  assert.doesNotMatch(source, /const syncRecoveryNeeded = state === "DEGRADED"/u);
  assert.match(source, /detail\?\.provider === "META" && !detail\.disclosure_version/u);
  assertLocalizedCopy(source, english, "tenant.connection.lifecycle.action.sync", "Refresh groups");
  assertLocalizedCopy(source, english, "tenant.connection.lifecycle.automaticGroups", "Groups update automatically in the background. Manual refresh appears only after an automatic refresh fails.");
  assert.ok(arabic.includes('"tenant.connection.lifecycle.action.sync": "مزامنة المجموعات"'));
});

test("onboarding exposes no-store QR, pairing, and extension-assisted passkey recovery", async () => {
  const [source, dictionary, arabic] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  assert.match(source, /useState\(\(\) => crypto\.randomUUID\(\)\)/);
  assertLocalizedCopy(source, dictionary, "tenant.actions.retrySameRequest", "Retry same request");
  assert.match(source, /\/auth\/qr/);
  assert.match(source, /\/auth\/pairing-code/);
  assert.match(source, /waha-passkey-sign/);
  assert.match(source, /ghpdcgnjffaaekflfpcgkgpbafmjldcp/);
  assert.match(source, /waha-passkey-extension/);
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.passkey.showAdvanced", "Show advanced manual option");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.pairing.codeBody", "Enter this code in WhatsApp while it remains current. WasalX does not store it.");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.expiredTitle", "QR code expired");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.expand", "Expand QR code");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.reduce", "Reduce QR code");
  assert.match(source, /qr && !qrExpired && qr\.imageDataUrl/);
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.validFor", "Valid for {duration}");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.issued", "Issued {time}");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.restart", "Restart QR authorization");
  assert.match(source, /runAction\("restart"\)/);
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.lastValidPreserved", "{message} The last valid QR code remains visible until {expiresAt}.");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.notReady", "A fresh QR code is not ready yet. WasalX will keep checking automatically.");
  assert.match(source, /authorizationRetry\?\.kind === "qr"/);
  assert.match(source, /setQrPollAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(source, /autoLoadedQrReadyAt\.current === qrReadyAt/u);
  assert.match(source, /autoLoadingQrReadyAt\.current === qrReadyAt/u);
  assert.match(source, /state !== "AWAITING_AUTH"[\s\S]{0,180}providerState !== "SCAN_QR_CODE"/u);
  assert.match(source, /void loadQr\(\)\.then\(\(loaded\) =>/u);
  assert.match(source, /if \(loaded\) \{\s*autoLoadedQrReadyAt\.current = qrReadyAt/u);
  assert.match(source, /setQrPollAttempt\(\(attempt\) => attempt \+ 1\);\s*\}, 2_000\)/u);
  assert.match(source, /generation !== refreshGeneration\.current/u);
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.qr.refreshing", "Refreshing QR code…");
  assert.doesNotMatch(source, /if \(!silent \|\| sessionExpired\) setQr\(null\)/);
  assertLocalizedCopy(source, dictionary, "tenant.connection.signInAgain", "Sign in again");
  assert.match(source, /setQr\(null\)/);
  assert.doesNotMatch(source, /navigator\.credentials\.get/);
  assert.doesNotMatch(source, /new PublicKeyCredential|AuthenticatorAssertionResponse/);
  assertLocalizedCopy(source, dictionary, "tenant.connection.guidance.connecting.body", "WhatsApp is preparing this connection. WasalX will update this page automatically.");
  assertLocalizedCopy(source, dictionary, "tenant.connection.authorization.refreshForAction", "Waiting for WhatsApp to report the next authorization step. This page updates automatically.");
  assert.ok(arabic.includes('"tenant.connection.guidance.connecting.body": "يجهّز واتساب هذا الاتصال. سيحدّث WasalX هذه الصفحة تلقائيًا."'));
  assert.ok(arabic.includes('"tenant.connection.authorization.refreshForAction": "في انتظار واتساب للإبلاغ عن خطوة التفويض التالية. تُحدَّث هذه الصفحة تلقائيًا."'));
});

test("connection setup owns keyboard focus, Escape dismissal, and trigger restoration", async () => {
  const [source, modal, dictionary] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("app/ModalDialog.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.match(source, /data-modal-initial-focus/);
  assert.match(modal, /modal\.showModal\(\)/);
  assert.match(modal, /modal\.addEventListener\("keydown", retainFocus\)/);
  assert.match(modal, /restoreIsolation = isolateSiblings\(modal, document\.body\)/);
  assert.match(modal, /closedby: "closerequest"/);
  assert.match(modal, /onCancel=\{\(event\) => \{/);
  assert.match(modal, /if \(event\.defaultPrevented\) return;/);
  assert.match(modal, /onClose=\{\(event\) =>/);
  assert.match(modal, /const restoreFocus = \(\) => \{[\s\S]*target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(modal, /aria-modal="true"/);
  assertLocalizedCopy(source, dictionary, "tenant.setup.actions.close", "Close connection setup");
  assert.match(source, /const closeGuard = useDialogCloseGuard\(close, creating\)/u);
  assert.match(source, /data-unsaved=\{closeGuard\.dirty \|\| undefined\}/u);
  assert.match(source, /onChangeCapture=\{closeGuard\.markDirty\}/u);
  assert.match(source, /<DirtyCloseConfirmation guard=\{closeGuard\}/u);
  assert.doesNotMatch(source, /typeof record\?\.error === "string" \? record\.error/u);
  assert.doesNotMatch(source, /typeof data\.error === "string" \? data\.error/u);
  assertLocalizedCopy(source, dictionary, "tenant.dialog.discard.title", "Discard unsaved changes?");
  assertLocalizedCopy(source, dictionary, "tenant.connection.errors.passkeyExtensionUnavailable", "The secure browser extension is not available in this browser.");
});

test("connection detail guards only the draft that changed and never traps persisted retries", async () => {
  const source = await read("app/WasalXApp.tsx");
  const detail = source.slice(
    source.indexOf("function ConnectionDetail("),
    source.indexOf("function MetaCredentialRotation("),
  );

  assert.match(detail, /const operationPending = \["STAGED", "QUEUED", "RUNNING", "FAILED_RETRYABLE"\]/u);
  assert.match(detail, /const closeGuard = useDialogCloseGuard\(\s*close,\s*actionPending \|\| authorizationPending \|\| metaReconnectPending \|\| metaNumberReleasePending,\s*dirtyDrafts\.size > 0/u);
  assert.doesNotMatch(detail, /useDialogCloseGuard\([\s\S]{0,120}operationPending/u);
  assert.doesNotMatch(detail, /connection-detail-shell[^>]*onChangeCapture/u);
  for (const sourceName of ["authorization", "credential", "group", "disconnect", "reconnect"]) {
    assert.match(detail, new RegExp(`setDraftDirty\\("${sourceName}"`, "u"));
  }
  assert.match(detail, /rotated=\{async \(\) => \{\s*setDraftDirty\("credential", false\)/u);
  assert.match(detail, /committed=\{\(\) => setDraftDirty\("group", false\)\}/u);
  assert.match(detail, /if \(intent\.action === "disconnect"\) \{[\s\S]{0,120}setDraftDirty\("disconnect", false\)/u);
  assert.match(detail, /setDisconnecting\(false\);\s*setConfirmation\(""\);\s*setDraftDirty\("disconnect", false\)/u);
});

test("portal publishes every authorization proxy with permission, CSRF, idempotency, and no-store controls", async () => {
  const routes = [
    "app/api/connections/[id]/auth/qr/route.ts",
    "app/api/connections/[id]/auth/scan-complete/route.ts",
    "app/api/connections/[id]/auth/pairing-code/route.ts",
    "app/api/connections/[id]/auth/passkey/challenge/route.ts",
    "app/api/connections/[id]/auth/passkey/route.ts",
    "app/api/connections/[id]/auth/passkey/confirmation/route.ts",
    "app/api/connections/[id]/auth/passkey/confirm/route.ts",
  ];
  await Promise.all(routes.map((path) => access(new URL(`../${path}`, import.meta.url))));
  const proxy = await read("app/api/connections/_authorization.ts");
  assert.match(proxy, /authenticatePortalRequest\(request, "connection:write"\)/);
  assert.match(proxy, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(proxy, /Cache-Control.*no-store/);
  assert.match(proxy, /isControlPlaneBackend\(\)/);
  assert.match(proxy, /submitWahaPasskey/);
  assert.match(proxy, /recordWahaScanCompleted/);
});

test("onboarding timing records only durable QR, human, and provider milestones", async () => {
  const [migration, acknowledgementMigration, worker, lifecycle, control, projection, portal, dictionary] = await Promise.all([
    read("services/control-api/migrations/0039_connection_onboarding_timing.sql"),
    read("services/control-api/migrations/0042_waha_scan_acknowledgement.sql"),
    read("services/connector-worker/src/inbound-repository.ts"),
    read("services/connector-worker/src/connection-operation-repository.ts"),
    read("services/control-api/src/waha-authorization.service.ts"),
    read("services/control-api/src/connections.controller.ts"),
    read("app/WasalXApp.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  for (const column of ["onboarding_qr_ready_at", "onboarding_scan_completed_at", "onboarding_working_at"]) {
    assert.match(migration, new RegExp(column));
  }
  assert.match(acknowledgementMigration,/ADD COLUMN onboarding_scan_acknowledged_at timestamptz/u);
  assert.match(acknowledgementMigration,/ADD COLUMN onboarding_authorization_method text/u);
  assert.match(acknowledgementMigration,/SET onboarding_scan_acknowledged_at=onboarding_scan_completed_at/u);
  assert.match(acknowledgementMigration,/audit\.target_id=session\.connection_id::text/u);
  assert.match(worker, /onboarding_qr_ready_at=CASE WHEN \$2='SCAN_QR_CODE' THEN \$4/u);
  assert.match(worker, /onboarding_scan_acknowledged_at=CASE\s+WHEN \$2='SCAN_QR_CODE' THEN NULL/u);
  assert.match(worker,/onboarding_scan_acknowledged_at<=COALESCE\(onboarding_working_at,\$4\)/u);
  assert.match(worker, /WHEN \$2='WORKING' AND onboarding_qr_ready_at IS NOT NULL THEN COALESCE\(onboarding_working_at,\$4\)/);
  assert.match(lifecycle,/onboarding_scan_acknowledged_at<=COALESCE\(onboarding_working_at,now\(\)\)/u);
  assert.match(control, /connection\.auth_scan_completed/);
  assert.match(control, /session\.provider_state='SCAN_QR_CODE'/);
  assert.match(control, /session\.provider_state='WORKING'/);
  assert.doesNotMatch(control,/SET onboarding_scan_completed_at=COALESCE/u);
  assert.match(projection,/ps\.onboarding_scan_acknowledged_at/u);
  assert.match(projection,/ps\.onboarding_authorization_method/u);
  assert.match(projection,/AS onboarding_timing_eligible/u);
  assert.match(projection,/AS onboarding_late_acknowledgement/u);
  assertLocalizedCopy(portal, dictionary, "tenant.connection.authorization.scan.finished", "I finished scanning");
  assert.match(portal,/detail\.onboarding_authorization_method === "QR"/u);
  assertLocalizedCopy(portal, dictionary, "tenant.connection.authorization.scan.connected", "Scan acknowledged. WhatsApp is connected.");
  assertLocalizedCopy(portal, dictionary, "tenant.connection.health.connectionTime", "Connection time");
  assert.doesNotMatch(migration.replaceAll(/^--.*$/gmu, ""), /phone|qr_image|payload/u);
});

test("creation and lifecycle BFF routes preserve accepted status responses", async () => {
  const createRoute = await read("app/api/connections/route.ts");
  const lifecycle = await read("lib/control-plane-data.ts");
  assert.match(createRoute, /status: 202/);
  assert.match(lifecycle, /ConnectionOperationAccepted/);
  assert.match(lifecycle, /encodeURIComponent\(id\)/);
  assert.match(lifecycle, /"idempotency-key": idempotencyKey/);
});

test("WAHA onboarding exposes only the qualified immutable engine and fails closed across every write boundary", async () => {
  const [portal, route, control, repository, migration, fixture, dictionary] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("app/api/connections/route.ts"),
    read("services/control-api/src/connections.controller.ts"),
    read("services/connector-worker/src/connection-operation-repository.ts"),
    read("services/control-api/migrations/0028_connection_engine_selection.sql"),
    read("lib/fixture-data.ts"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.doesNotMatch(portal, /waha-engine-noweb|setWahaEngine|value="NOWEB"/u);
  assert.doesNotMatch(portal, /\bwahaEngine\b/u);
  assert.match(portal, /engine: provider === "waha" \? "GOWS" : undefined/u);
  assert.match(portal, /provider === "waha" \? t\("tenant\.setup\.mode\.recommended"\)/u);
  assertLocalizedCopy(portal, dictionary, "tenant.setup.ready.capacityValue", "Compatible capacity reserved · no automatic fallback");
  assert.match(route, /requestedEngine !== "GOWS"/);
  assert.doesNotMatch(route, /requestedEngine !== "NOWEB"/);
  assert.match(route, /else if \(body\.engine !== undefined\)/);
  assert.match(control, /request: \{ name, provider, engine, disclosureVersion \}/);
  assert.match(control, /requestedEngine !== expected\.engine/);
  assert.match(repository, /app\.acquire_waha_session_assignment\(\$1,\$2,\$3/);
  assert.match(repository, /\[sessionId, engine, leaseForSeconds\]/);
  assert.match(migration, /connections_provider_engine_check/);
  assert.match(migration, /connections_provider_engine_immutable/);
  assert.match(fixture, /input\.engine!==undefined&&input\.engine!=="GOWS"/u);
  assert.match(fixture, /Created \$\{input\.provider\} connection with \$\{engine\}/);
});

test("fixture creation rejects unsupported engines while preserving qualified provisioning detail", async () => {
  const fixture = await import(`../lib/fixture-data.ts?connection-operation=${Date.now()}`);
  await assert.rejects(() => fixture.createConnection({provider:"WAHA",name:"Unsupported",engine:"NOWEB"},"Browser operator"),/Only the qualified GOWS engine/u);
  const accepted = await fixture.createConnection(
    {
      provider: "WAHA",
      name: "GOWS acceptance proof",
      engine: "GOWS",
      disclosureAccepted: true,
      disclosureVersion: "2026-08-09",
    },
    "Browser operator",
  );
  assert.match(accepted.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(accepted.operation.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(accepted.state, "PROVISIONING");
  assert.equal(accepted.operation.type, "PROVISION");
  assert.equal(accepted.operation.state, "QUEUED");

  const dashboard = await fixture.getDashboardData();
  const detail = dashboard.connections.find((row) => row.id === accepted.id);
  assert.ok(detail);
  assert.equal(detail.engine, "GOWS");
  assert.equal(detail.latest_operation_id, accepted.operation.id);
  assert.equal(detail.latest_operation_type, "PROVISION");
  assert.equal(detail.latest_operation_state, "QUEUED");
  assert.equal(detail.latest_operation_attempts, 0);
  assert.ok(detail.latest_operation_created_at);
});


test("manual Meta reservation conflicts keep safe localized meaning and preserve generic fallbacks", async () => {
  const source = await read("app/WasalXApp.tsx");
  const file = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node, predicate) {
    if (predicate(node)) return node;
    return ts.forEachChild(node, child => find(child, predicate));
  }
  const setup = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === "ConnectionModal");
  assert.ok(setup, "manual connection modal exists");
  const create = find(setup, node => ts.isVariableDeclaration(node) && node.name.getText(file) === "create");
  assert.ok(create, "manual setup handler exists");
  const rejection = find(create, node => ts.isIfStatement(node) && node.expression.getText(file) === "!response.ok");
  assert.ok(rejection, "execute the setup handler's actual response rejection branch");
  const { outputText } = ts.transpileModule(rejection.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const rejectResponse = new AsyncFunction("response", "provider", "t", "apiError", "setAssetConflict", "operatorLocalFailure", outputText);
  const caught = find(create, node => ts.isCatchClause(node));
  assert.equal(caught?.variableDeclaration?.name.getText(file), "requestError");
  const finishRejection = new Function("requestError", "setError", "operatorFailureMessage", "t",
    ts.transpileModule(caught.block.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  const resets = create.initializer.body.statements.filter(ts.isExpressionStatement).map(node => node.getText(file)).join("\n");
  const resetState = new Function("setCreating", "setError", "setAssetConflict", ts.transpileModule(resets, {}).outputText);
  assert.match(setup.getText(file), /\{!assetConflict && \(\s*<small>/u);
  const raw = "private provider details must never appear";
  const code = "META_SIGNUP_ASSET_CONFLICT";
  for (const dictionary of [englishTenantMessages, arabicTenantMessages]) {
    for (const input of [
      { provider: "meta", status: 409, body: { code, message: raw, error: raw }, specific: true },
      { provider: "meta", status: 409, body: { code: "OTHER_CONFLICT", message: raw } },
      { provider: "meta", status: 503, body: { code, message: raw } },
      { provider: "waha", status: 409, body: { code, message: raw } },
      { provider: "meta", status: 409, body: null },
      { provider: "meta", status: 409, malformed: true },
    ]) {
      const response = new Response(input.malformed ? "not-json" : JSON.stringify(input.body), { status: input.status });
      let fallbacks = 0;
      let assetConflict = true;
      resetState(() => {}, () => {}, value => { assetConflict = value; });
      assert.equal(assetConflict, false, "a new attempt resets the prior permanent conflict");
      const expected = input.specific ? dictionary["tenant.metaSignup.reason.META_SIGNUP_ASSET_CONFLICT"] : "safe generic fallback";
      await assert.rejects(rejectResponse(response, input.provider, key => {
        assert.equal(key, "tenant.metaSignup.reason.META_SIGNUP_ASSET_CONFLICT");
        return dictionary[key];
      }, async original => {
        fallbacks++;
        assert.equal(original, response);
        assert.equal(original.bodyUsed, false, "inspecting a conflict must leave the fallback body readable");
        assert.deepEqual(await original.json().catch(() => null), input.malformed ? null : input.body);
        return "safe generic fallback";
      }, value => { assetConflict = value; }, operatorLocalFailure), error => {
        let displayed;
        finishRejection(error, value => { displayed = value; }, operatorFailureMessage, key => dictionary[key]);
        return error.message === expected && displayed === expected && !displayed.includes(raw);
      });
      assert.equal(fallbacks, input.specific ? 0 : 1);
      assert.equal(assetConflict, input.specific === true, "only a known permanent conflict suppresses retry guidance");
    }
    let unknown;
    finishRejection(new Error(raw), value => { unknown = value; }, operatorFailureMessage, key => dictionary[key]);
    assert.equal(unknown, dictionary["tenant.setup.errors.request"], "untrusted errors keep the safe request fallback");
  }
});

test("manual setup console expectations consume only exact fixture failures once", async () => {
  const source = await read("tests/e2e/meta-direct-consent.fixture.ts");
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const consumer = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "consumeExpectedDirectSetupDenial");
  assert.ok(consumer);
  const code = ts.transpileModule(consumer.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const expected = new WeakMap();
  const consume = new Function("expectedDirectSetupFailures", code.replace("export ", "") + "; return consumeExpectedDirectSetupDenial;")(expected);
  const page = {}, url = "http://fixture.invalid/api/connections";
  const failures = [{ url, status: 409 }, { url, status: 503 }];
  expected.set(page, failures);
  const message = (status, location = url, prefix = "Failed to load resource:") => ({
    text: () => prefix + " the server responded with a status of " + status,
    location: () => ({ url: location }),
  });
  assert.equal(consume({}, message(409)), false);
  assert.equal(consume(page, message(409, url + "/other")), false);
  assert.equal(consume(page, message(500)), false);
  assert.equal(consume(page, message(4090)), false);
  assert.equal(consume(page, message(409, url, "Unexpected error:")), false);
  assert.equal(failures.length, 2);
  assert.equal(consume(page, message(409)), true);
  assert.equal(consume(page, message(409)), false);
  assert.equal(failures.length, 1);
  assert.equal(consume(page, message(503)), true);
  assert.equal(consume(page, message(503)), false);
  assert.equal(failures.length, 0);
});
