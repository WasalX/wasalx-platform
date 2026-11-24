import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const assertDictionaryCopy = (dictionary, key, copy) => {
  assert.ok(dictionary.includes(`"${key}": ${JSON.stringify(copy)}`), `${key} must keep its English copy`);
};
const assertLocalizedCopy = (source, dictionary, key, copy) => {
  assert.ok(source.includes(`t("${key}"`), `${key} must be rendered through t()`);
  assertDictionaryCopy(dictionary, key, copy);
};

test("operator data refreshes automatically while visible and preserves manual recovery", async () => {
  const [hook, shell, cases, bots, routing, dashboard, platform, english, arabic, operatorUi] = await Promise.all([
    read("app/use-visible-refresh.ts"),
    readTenantPortalSource(),
    read("app/CaseLifecycle.tsx"),
    read("app/BotAutomation.tsx"),
    read("app/ClientRouting.tsx"),
    read("app/api/dashboard/route.ts"),
    read("app/platform/PlatformConsole.tsx"),
    read("lib/i18n/messages/en/platform.ts"),
    read("lib/i18n/messages/ar/platform.ts"),
    read("lib/operator-ui.ts"),
  ]);
  assert.match(hook, /document\.visibilityState !== "visible"/u);
  assert.match(hook, /intervalMs = 30_000/u);
  assert.match(hook, /window\.setInterval\(schedule, intervalMs\)/u);
  assert.match(hook, /document\.addEventListener\("visibilitychange", schedule\)/u);
  assert.match(hook, /window\.addEventListener\("focus",schedule\)/u);
  assert.match(hook, /window\.addEventListener\("pageshow",restore\)/u);
  assert.match(hook, /requestAnimationFrame\(run\)/u);
  assert.match(hook, /const controller = new AbortController\(\)/u);
  assert.match(hook, /latest\.current\(controller\.signal\)/u);
  assert.match(hook, /active\?\.abort\(\)/u);
  assert.match(hook, /window\.clearInterval\(timer\)/u);
  assert.match(hook, /document\.removeEventListener\("visibilitychange", schedule\)/u);
  assert.match(hook, /window\.removeEventListener\("pageshow",restore\)/u);
  assert.match(hook, /\[enabled, intervalMs\]/u);
  assert.match(cases, /useVisibleRefresh\(\(signal\) => load\(true, signal\)/u);
  assert.match(cases, /fetch\("\/api\/cases\?limit=200", \{ cache: "no-store", signal \}\)/u);
  assert.match(cases, /loadFence\.current\.isCurrent\(request\)/u);
  assert.match(bots, /useVisibleRefresh\(\(signal\) => load\(true, signal\), !saving\)/u);
  assert.match(bots, /fetch\("\/api\/bot-flows\/actions\/catalog\?limit=50", \{ cache: "no-store", signal \}\)/u);
  assert.match(bots, /loadFence\.current\.isCurrent\(request\)/u);
  assert.match(routing, /useVisibleRefresh\(\(signal\) => load\(true, signal\), !loading && !busy/u);
  for(const helper of ["routingData","routingSourceData","routingCatalogData","routingIntegrationData"]){assert.match(routing,new RegExp(`${helper}[\\s\\S]*signal\\?: AbortSignal`))}
  assert.match(routing, /refreshFence\.current\.isCurrent\(request\)/u);
  assert.match(routing, /current === previous \? activeId : current/u);
  assert.match(routing, /const \[hasLoaded, setHasLoaded\] = useState\(false\)/u);
  assert.match(routing, /if \(error && !hasLoaded\)/u);
  // Later errors retain New draft; open/busy/loading or missing detail prevents premature editing.
  assert.match(routing, /disabled=\{editor !== null \|\| busy \|\| loading \|\| Boolean\(selected && !definition\)\}/u);
  assert.match(routing, /connected: "common\.status\.connected"/u);
  assert.match(dashboard, /authenticatePortalRequest\(request\)/u);
  assert.match(dashboard, /"cache-control": "private, no-store"/u);
  assert.equal(shell.match(/useVisibleRefresh\(/gu)?.length, 12);
  assert.match(shell, /const loadDashboard = useCallback\(async \(signal\?: AbortSignal\)[\s\S]{0,300}fetch\("\/api\/dashboard", \{ cache: "no-store", signal \}\)/u);
  assert.match(shell, /shouldPauseAutomaticRefresh\(\)[\s\S]{0,200}loadDashboard\(signal\)/u);
  for(const fence of ["workspaceLoadFence","openReviewsLoadFence","dashboardLoadFence"])assert.match(shell,new RegExp(`const ${fence}=useRef\\(createLatestRequestFence\\(\\)\\)`));
  assert.match(shell,/installShellFetch\(window, \{\s*tenantId: String\(initialData\.tenant\.id\),\s*role,/u);
  assert.match(shell,/result\.data\.tenant\?\.id/u);
  assert.match(shell,/tenant\.workspace\.loadFailed/u);
  assert.doesNotMatch(shell,/setWorkspaces\(\[\]\)/u);
  assert.match(operatorUi, /\[data-unsaved="true"\], dialog\[open\] form, \[contenteditable="true"\]/u);
  assert.doesNotMatch(operatorUi, /querySelector\("form,/u);
  assert.doesNotMatch(shell, /useVisibleRefresh\(async \(signal\) => \{[\s\S]{0,500}router\.refresh\(\)/u);
  assert.doesNotMatch(shell, /router\.refresh\(\)/u);
  assert.match(shell, /useVisibleRefresh\(\(signal\) => loadCatalog\(signal, true\)\)/u);
  assert.match(shell, /useVisibleRefresh\(\s*\(signal\) => refresh\(signal\),\s*!actionPending && !authorizationPending && !metaReconnectPending && !metaNumberReleasePending && !disconnecting\s*&& \(dirtyDrafts\.size === 0 \|\| \(dirtyDrafts\.size === 1 && dirtyDrafts\.has\("reconnect"\)\)\)/u);
  assert.match(shell, /lifecycleTransitionPending \? 2_000 : 30_000/u);
  assert.match(shell, /authorizationState\(authorizationHealthState, t\)/u);
  assert.doesNotMatch(shell, /setInterval\(\(\) => void refresh\(\), 5_000\)/u);
  assert.match(shell, /useVisibleRefresh\(\(signal\) => loadReviews\(signal\), mode === "review" && canReadReview && selectedReviewId === null\)/u);
  assert.match(shell, /useVisibleRefresh\(\(signal\) => load\(true, signal\), selected === null\)/u);
  assert.match(shell, /useVisibleRefresh\(\(signal\) => load\(true, signal\), !inviteOpen && editing === null && busyId === null\)/u);
  assert.match(shell, /reviewLoadFence\.current\.isCurrent\(request\)/u);
  assert.match(shell, /!isPrivateDemo && !dirty && !saving/u);
  assert.match(shell, /!isPrivateDemo&&!dirty&&busy===null&&!holdOpen&&!requestType&&!releaseHold&&!retryRequest&&!detailId/u);
  assert.match(operatorUi, /root\.querySelector\('\[data-unsaved="true"\]'\)/u);
  assert.match(shell, /data-unsaved=\{dirty\|\|undefined\}/u);
  assert.match(routing, /data-unsaved=\{dirty \|\| undefined\}/u);
  assert.match(bots, /data-unsaved=\{dirty \|\| undefined\}/u);
  assert.match(shell, /next !== view && !confirmUnsavedNavigation/u);
  assert.match(shell, /useVisibleRefresh\(\(signal\) => loadHistory\(true, signal\), !historyDirty && !historySaving\)/u);
  assert.match(shell, /useVisibleRefresh\(signal=>load\(true,signal\),!dirty&&!saving\)/u);
  assert.match(shell, /fetch\("\/api\/group-workspace\/settings",\{cache:"no-store",signal\}\)/u);
  assert.match(shell, /loadError instanceof DOMException&&loadError\.name==="AbortError"/u);
  assert.match(shell, /const SETTINGS_SECTION_STORAGE_KEY = "wasalx:settings-section"/u);
  assert.match(shell, /stored === "general" \|\| stored === "identity" \|\| stored === "security" \|\| stored === "groupHistory" \|\| stored === "privacy"/u);
  assert.match(shell, /stored !== "privacy" \|\| canReadPrivacy/u);
  assert.match(shell, /function InviteMemberDialog[\s\S]*?useDialogCloseGuard\(close,saving\)[\s\S]*?onChangeCapture=\{closeGuard\.markDirty\}/u);
  assert.match(shell, /function MemberAccessDialog[\s\S]*?useDialogCloseGuard\(close,saving\)[\s\S]*?onChangeCapture=\{closeGuard\.markDirty\}/u);
  assert.match(shell, /states\.map\(\(value\) => <option key=\{value\} value=\{value\}>\{t\(statusPresentation\(value\)\[0\]\)\}/u);
  assert.match(platform, /useVisibleRefresh\(async \(signal\) =>/u);
  assertLocalizedCopy(platform, english, "platform.feedback.refreshFailed", "Background refresh failed. WasalX will retry automatically.");
  assert.match(arabic, /"platform\.feedback\.refreshFailed":/u);
  assert.doesNotMatch(shell, /tenant\.connection\.refreshState/u);
  assert.doesNotMatch(cases, /\{t\("cases\.refresh"\)\}/u);
});

test("overview metric titles carry no empty info marks", async () => {
  const [app, styles] = await Promise.all([read("app/WasalXApp.tsx"), read("app/globals.css")]);
  assert.doesNotMatch(app, /className="info"/u, "an info mark without a description offers nothing");
  assert.doesNotMatch(styles, /(?:^|\})\s*\.info\s*\{/mu, "the unused info mark style is removed");
  assert.match(app, /<span>\s*\{t\("tenant\.overview\.workingConnections"\)\}\s*<\/span>/u);
});

test("visible refresh lets slow requests finish and recovers after cancellation and callback failure", async () => {
  const source = await read("app/use-visible-refresh.ts");
  const emitted = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^import .*;\n/gmu, "").replace("export function useVisibleRefresh", "function useVisibleRefresh");
  const effects = [];
  const frames = new Map();
  let nextFrame = 0, tick;
  const browser = new EventTarget();
  browser.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  browser.cancelAnimationFrame = (frame) => frames.delete(frame);
  browser.setInterval = (callback) => { tick = callback; return 1; };
  browser.clearInterval = () => { tick = null; };
  const document = new EventTarget();
  document.visibilityState = "visible";
  const useVisibleRefresh = new Function("useEffect", "useRef", "window", "document", `${emitted}\nreturn useVisibleRefresh;`)(
    (effect) => effects.push(effect), (current) => ({ current }), browser, document,
  );
  const requests = [];
  let fail = false;
  useVisibleRefresh((signal) => {
    if (fail) throw new Error("refresh failed synchronously");
    return new Promise((resolve) => requests.push({ signal, resolve }));
  }, true, 2_000);
  const cleanups = effects.map((effect) => effect());
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const flushFrame = async () => {
    for (const [frame, callback] of frames) { frames.delete(frame); callback(); }
    await drain();
  };

  tick(); await flushFrame();
  assert.equal(requests.length, 1);
  tick(); browser.dispatchEvent(new Event("focus")); await flushFrame();
  assert.equal(requests.length, 1, "a pending request survives later polling ticks");
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(); await drain();
  tick(); await flushFrame();
  assert.equal(requests.length, 2, "polling resumes after the request finishes");

  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests[1].signal.aborted, true);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange")); await flushFrame();
  assert.equal(requests.length, 3, "returning to the tab starts fresh work");
  requests[1].resolve(); await drain();
  tick(); await flushFrame();
  assert.equal(requests.length, 3, "settling an aborted request cannot clear a newer pending request");
  requests[2].resolve(); await drain();

  fail = true; tick(); await flushFrame();
  fail = false; tick(); await flushFrame();
  assert.equal(requests.length, 4, "a synchronous callback error does not stop future polling");
  for (const cleanup of cleanups) cleanup?.();
  assert.equal(requests[3].signal.aborted, true);
  assert.equal(tick, null);
  browser.dispatchEvent(new Event("focus"));
  assert.equal(frames.size, 0);
});

test("group searches and routing qualification status fence superseded requests", async () => {
  const [groups, routing] = await Promise.all([readTenantPortalSource(), read("app/ClientRouting.tsx")]);
  assert.match(groups, /const connectionIds = connections\.map/u);
  assert.match(groups, /!controller\.signal\.aborted && filterFence\.isCurrent\(request\)/u);
  assert.match(groups, /pageFence\.invalidate\(\);pageController\.current\?\.abort\(\)/u);
  assert.match(groups, /!controller\.signal\.aborted && groupPageFence\.current\.isCurrent\(request\)/u);
  assert.match(groups, /const bulkSelectionTooLarge = selected\.size > 100/u);
  assert.match(groups, /disabled=\{bulkSelectionTooLarge\} onClick=\{\(\) => setBulkAction\(false\)\}/u);
  assert.match(groups, /disabled=\{bulkSelectionTooLarge\|\|selectedActivationCodes\.length>0\}/u);
  assert.match(groups, /t\("tenant\.group\.bulk\.limit", \{ count: formatNumber\(100, locale\) \}\)/u);
  assert.match(routing, /if \(qualificationVersion\.current !== versionId \|\| signal\?\.aborted\) return/u);
  assert.match(routing, /qualificationVersion\.current === versionId && qualificationFence\.current\.isCurrent\(request\)/u);
  assert.match(routing, /useVisibleRefresh\(\(signal\) => loadSources\(signal\), sourceStates\.length > 0, sourceJobsPending \? 3_000 : 30_000\)/u);
  assert.match(routing, /selected\?\.state === "DRAFT", qualificationJobsPending \? 3_000 : 30_000/u);
  assert.doesNotMatch(routing, /if\(document\.visibilityState==="visible"\)void loadQualifications/u);
});

test("a group page settling after a filter change cannot alter the new rows, errors, or loading state", async () => {
  const source = await readTenantPortalSource();
  const ast = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const groups = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "Groups");
  let pageLoader;
  const findPageLoader = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "loadOlder") pageLoader = node.initializer.getText(ast);
    ts.forEachChild(node, findPageLoader);
  };
  findPageLoader(groups);
  assert.ok(pageLoader);
  const emitted = ts.transpileModule(`const loadOlder = ${pageLoader};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const { createLatestRequestFence } = await import("../lib/operator-ui.ts");

  for (const outcome of ["success", "failure"]) {
    const requests = [];
    const fence = { current: createLatestRequestFence() };
    const controller = { current: null };
    const writes = [];
    let rows = [{ id: "new-first" }];
    const scope = {
      visibleGroupCount: 50, filtered: [], loadingOlder: false, remoteFilter: true,
      filteredRows: [{ id: "old-first" }], allRows: [], rows: [], query: "old", connectionFilter: "all",
      GROUP_DISPLAY_PAGE_SIZE: 50, groupPageFence: fence, groupPageController: controller,
      fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
      apiError: async () => "unavailable", t: (key) => key,
      isAbortError: (problem) => problem?.name === "AbortError",
      setLoadingOlder: (value) => writes.push(["loading", value]),
      setOlderError: (value) => writes.push(["error", value]),
      setFilteredRows: (update) => { rows = update(rows); writes.push(["rows", rows]); },
      setFilterPageAvailable: (value) => writes.push(["more", value]),
      setVisibleGroupCount: (update) => writes.push(["visible", update(50)]),
      setOlderRows: () => assert.fail("remote pages must not write the unfiltered list"),
      setOlderPageAvailable: () => assert.fail("remote pages must not write the unfiltered cursor"),
    };
    const load = () => new Function(...Object.keys(scope), `${emitted}\nreturn loadOlder;`)(...Object.values(scope))();
    const previous = load();
    // The Groups effect invalidates and aborts when its filter or first page changes.
    fence.current.invalidate(); controller.current.abort();
    scope.query = "new"; scope.filteredRows = [{ id: "new-first" }];
    const current = load();
    assert.match(requests[1].url, /q=new/u);
    assert.equal(requests[0].options.signal.aborted, true);
    requests[1].resolve(Response.json([{ id: "new-second" }])); await current;
    assert.deepEqual(rows, [{ id: "new-first" }, { id: "new-second" }]);
    const settledWrites = [...writes];
    if (outcome === "success") requests[0].resolve(Response.json([{ id: "old-second" }]));
    else requests[0].reject(new Error("old page failed"));
    await previous;
    assert.deepEqual(writes, settledWrites, `stale ${outcome} must not affect the current view`);
    assert.deepEqual(rows, [{ id: "new-first" }, { id: "new-second" }]);
  }
});

test("stale tenant data is labeled without claiming an empty workspace", async () => {
  const [source, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  assertLocalizedCopy(source, english, "tenant.data.refreshFailed", "Refresh failed. The last confirmed information remains visible.");
  assertDictionaryCopy(arabic, "tenant.data.refreshFailed", "تعذر التحديث. تظل آخر معلومات مؤكدة ظاهرة.");
  assert.match(source, /items\.length\?<WideTable>[\s\S]{0,2000}:error\?null:<Empty title=\{t\("tenant\.deliveries\.review\.emptyTitle"\)\}/u);
  assert.match(source, /requests\.length \? <WideTable>[\s\S]{0,3000}: error \? null : <Empty title=\{t\("tenant\.support\.emptyTitle"\)\}/u);
  assert.match(source, /error && versions === null \? null : items\.length/u);
});

test("primary navigation exposes bypass and current-page semantics", async () => {
  const [source, styles, messages] = await Promise.all([
    readTenantPortalSource(),
    read("app/globals.css"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.match(source, /href="#main-content">\{t\("tenant\.accessibility\.skipToContent"\)\}<\/a>/u);
  assertDictionaryCopy(messages, "tenant.accessibility.skipToContent", "Skip to main content");
  assert.match(source, /<main id="main-content" tabIndex=\{-1\} inert=\{mobileNavigationOpen\|\|undefined\}>/u);
  assert.match(source, /aria-current=\{view === id \? "page" : undefined\}/u);
  assert.match(styles, /\.skip-link:focus \{ transform:none; \}/u);
  assert.match(styles, /\.audit-row small\{display:block;margin-block-start:3px\}/u);
});

test("tenant shell fails closed on expiry and adapts its persisted sidebar without hiding navigation", async () => {
  const [source, styles, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    read("app/globals.css"),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);

  assert.match(source, /onUnauthorized: \(\) => window\.dispatchEvent\(new CustomEvent\(SESSION_EXPIRED_EVENT/u);
  assert.match(source, /if \(expiredSessionReturnTo\) \{[\s\S]*<SessionExpired/u);
  assert.match(source, /window\.addEventListener\("pagehide",maskShell\)/u);
  assert.match(source, /window\.addEventListener\("pageshow",restore\)/u);
  assert.match(source, /workspaceLoadFence\.current\.invalidate\(\)/u);
  assert.match(source, /if\(!await verifyWorkspaces\(signal\)\)return;[\s\S]{0,100}if\(await loadDashboard\(signal\)\)/u);
  assert.match(source, /data-shell-validation=\{shellValidationState\}/u);
  assert.match(source, /inert=\{shellValidationState!=="ready"\|\|undefined\}/u);
  assert.match(styles, /\[data-shell-validation="checking"\]>\.app-shell/u);
  assert.match(source, /href=\{`\/auth\/login\?return_to=\$\{encodeURIComponent\(returnTo\)\}`\}/u);
  assert.match(source, /localStorage\.setItem\(SIDEBAR_PIN_KEY, String\(next\)\)/u);
  assert.match(source, /aria-pressed=\{sidebarPinned\}/u);
  assert.match(source, /title=\{t\(key\)\}/u);
  assert.match(styles, /@media \(min-width:761px\) and \(max-width:1000px\).*--sidebar-effective-width:72px/u);
  assert.match(styles, /@media\(max-width:760px\).*\.sidebar-pin\{display:none\}.*\.nav-label\{display:inline\}/u);
  for (const dictionary of [english, arabic]) {
    assert.match(dictionary, /"tenant\.session\.expiredTitle":/u);
    assert.match(dictionary, /"tenant\.sidebar\.pin":/u);
    assert.match(dictionary, /"tenant\.sidebar\.unpin":/u);
    assert.match(dictionary, /"tenant\.workspace\.verifyingAccess":/u);
    assert.match(dictionary, /"tenant\.workspace\.verificationFailed":/u);
  }
});

test("operator attention stays deduplicated and diagnostics remain role restricted", async () => {
  const [source, operatorUi] = await Promise.all([readTenantPortalSource(), read("lib/operator-ui.ts")]);
  assert.match(source, /function unmatchedReviews\(data: DashboardData\)/u);
  assert.match(source, /\.\.\.unmatchedReviews\(data\)\.map/u);
  assert.match(source, /const attention=deliveryIssues\+reviewIssues\+connectionIssues/u);
  assert.match(source, /String\(connection\.state\)\.toUpperCase\(\) !== "REVOKED"/u);
  assert.match(source, /showDiagnostics=\{role === "auditor"\}/u);
  assert.match(source, /visibleReviewMetadata\(detail\?\.safe_metadata,showDiagnostics,detail\?\.state\)/u);
  assert.match(operatorUi, /PUBLIC_REVIEW_METADATA_KEYS\.has\(key\)/u);
  assert.match(source, /groupDestination\(row\.zammad_group, t\)/u);
  assert.match(source, /String\(row\.rule_name\) === "Not configured" \? t\("tenant\.group\.destinationNotConfigured"\)/u);
});

test("operational BFF routes are authorized, bounded, and recover partial work", async () => {
  const [audit, auditPage, support, decision, bulk, content, bridge] = await Promise.all([
    read("app/api/audit/export/route.ts"),
    read("app/api/audit/route.ts"),
    read("app/api/support-access/route.ts"),
    read("app/api/support-access/_decision.ts"),
    read("app/api/groups/bulk-toggle/route.ts"),
    read("app/api/deliveries/[id]/content/route.ts"),
    read("lib/control-plane-data.ts"),
  ]);

  assert.match(audit, /authenticatePortalRequest\(request, "audit:export"\)/u);
  assert.match(audit, /private, no-store/u);
  assert.match(audit, /content-disposition/u);
  assert.match(audit, /limit < 1 \|\| limit > 10_000/u);
  assert.match(auditPage, /authenticatePortalRequest\(request, "audit:read"\)/u);
  assert.match(auditPage, /createdAt && id \? auditCursor\(createdAt, id\) : undefined/u);
  assert.match(auditPage, /private, no-store/u);
  assert.match(support, /authenticatePortalRequest\(request, "support:read"\)/u);
  assert.match(decision, /authenticatePortalRequest\(request, "support:approve"\)/u);
  assert.match(decision, /"approve" \| "deny" \| "revoke"/u);
  assert.match(bulk, /Promise\.allSettled/u);
  assert.doesNotMatch(bulk,/result\.reason(?:\?\.)?\.message|result\.reason\.message/u);
  assert.match(bulk,/code:"VALIDATION_ERROR"/u);
  assert.match(bulk,/code:"CONFLICT"/u);
  assert.match(bulk,/SAFE_GROUP_CODES\.has\(result\.reason\.code\)[\s\S]*"SERVICE_UNAVAILABLE"/u);
  assert.match(bulk, /status: succeeded === ids\.length \? 200 : 207/u);
  assert.match(bulk, /body\.ids\.length > 100/u);
  assert.match(content, /authenticatePortalRequest\(request, "delivery:content:read"\)/u);
  assert.match(content, /body\.purpose !== "OPERATIONAL_REVIEW"/u);
  assert.match(content, /body\.confirmation !== "REVEAL"/u);
  assert.match(bridge, /if \(init\.body !== undefined\) headers\.set\("content-type", "application\/json"\)/u);
  assert.match(bridge, /else headers\.delete\("content-type"\)/u);
});

test("audit history loads every retained page and keeps system identifiers out of normal copy", async () => {
  const [source, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  assert.match(source, /cursorId: String\(last\.id\)/u);
  assert.match(source, /fetch\(`\/api\/audit\?\$\{query\}`/u);
  assert.match(source, /const actorType = String\(row\.actor_type \?\? ""\)/u);
  assert.match(source, /"WORKSPACE_USER", "WORKSPACE_AGENT", "PLATFORM_OPERATOR"/u);
  assert.match(source, /t\("tenant\.audit\.actor\.automation"\)/u);
  assert.match(source, /action === "bot_action\.qualification_queued"[\s\S]{0,120}tenant\.audit\.action\.pluginActionTested/u);
  assertDictionaryCopy(english, "tenant.audit.action.pluginActionTested", "tested a plugin action");
  for (const alias of ['client: "routing"', 'review: "review"', 'waha: "connection"', 'zammad: "workspaceIntegration"']) {
    assert.ok(source.includes(alias), `${alias} must render as a public audit category`);
  }
  assertDictionaryCopy(english, "tenant.audit.loadOlder", "Load older activity");
  for (const dictionary of [english, arabic]) {
    assert.match(dictionary, /"tenant\.audit\.actor\.automation":/u);
    assert.match(dictionary, /"tenant\.audit\.errors\.loadOlder":/u);
    assert.match(dictionary, /"tenant\.audit\.category\.routing":/u);
    assert.match(dictionary, /"tenant\.audit\.category\.review":/u);
    assert.match(dictionary, /"tenant\.audit\.category\.workspaceIntegration":/u);
    assert.match(dictionary, /"tenant\.audit\.actor\.member":/u);
    assert.match(dictionary, /"tenant\.audit\.actor\.agent":/u);
    assert.match(dictionary, /"tenant\.audit\.actor\.support":/u);
  }
});

test("fixture exposes complete safe operational evidence without listing message bodies", async () => {
  const previousBackend = process.env.PORTAL_DATA_BACKEND;
  const previousRole = process.env.PORTAL_FIXTURE_ROLE;
  process.env.PORTAL_DATA_BACKEND = "fixture";
  process.env.PORTAL_FIXTURE_ROLE = "tenant_owner";
  try {
    const fixture = await import(`../lib/fixture-data.ts?portal-ops=${Date.now()}`);
    const dashboard = await fixture.getDashboardData();
    assert.equal(dashboard.tenant.runtime, "FIXTURE");
    for (const role of ["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor"]) {
      process.env.PORTAL_FIXTURE_ROLE = role;
      assert.equal((await fixture.getDashboardData()).tenant.role, role);
    }
    assert.ok(dashboard.deliveries.every((row) => row.excerpt === "Message content redacted"));
    assert.ok(dashboard.deliveries.every((row) => !("message_body" in row)));
    assert.equal(dashboard.deliveries.find((row) => row.state === "FAILED_TERMINAL")?.manual_retry_allowed, false);

    const detail = await fixture.getDeliveryDetail("16000000-0000-4000-8000-000000000003");
    assert.equal(detail.ticket_number, "#10380");
    assert.ok(Array.isArray(detail.delivery_attempts) && detail.delivery_attempts.length > 0);
    assert.ok(!("message_body" in detail));

    const reviewReasons = new Set((await fixture.getReviewItems()).map((row) => row.reason_code));
    assert.deepEqual(reviewReasons, new Set([
      "IDENTIFIER_LIMIT_EXCEEDED",
      "OUTBOUND_MEDIA_REJECTED",
      "PROVIDER_OUTCOME_UNKNOWN",
      "GROUP_ACTION_OUTCOME_UNKNOWN",
    ]));
    assert.equal((await fixture.getCases()).length, 4);
    assert.ok((await fixture.getTeamAccess()).members.length >= 5);
    assert.equal((await fixture.getWorkspaceSettings()).default_theme, "DARK");
    assert.deepEqual(
      new Set((await fixture.getSupportAccessRequests()).map((row) => row.state)),
      new Set(["PENDING", "APPROVED"]),
    );
    assert.deepEqual(
      new Set((await fixture.getRuleSetVersions()).map((row) => row.state)),
      new Set(["RETIRED", "ACTIVE", "DRAFT"]),
    );
  } finally {
    if (previousBackend === undefined) delete process.env.PORTAL_DATA_BACKEND;
    else process.env.PORTAL_DATA_BACKEND = previousBackend;
    if (previousRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE;
    else process.env.PORTAL_FIXTURE_ROLE = previousRole;
  }
});

test("fixture support, delivery, and rule governance transitions fail closed", async () => {
  const previousBackend = process.env.PORTAL_DATA_BACKEND;
  const previousRole = process.env.PORTAL_FIXTURE_ROLE;
  process.env.PORTAL_DATA_BACKEND = "fixture";
  process.env.PORTAL_FIXTURE_ROLE = "tenant_owner";
  try {
    const fixture = await import(`../lib/fixture-data.ts?portal-transitions=${Date.now()}`);
    const support = await fixture.getSupportAccessRequests();
    const pending = support.find((row) => row.state === "PENDING");
    assert.ok(pending);
    const approved = await fixture.decideSupportAccess(
      pending.id,
      "approve",
      { expectedVersion: pending.version, durationSeconds: 600 },
      "Maya Al-Salem",
    );
    assert.equal(approved.state, "APPROVED");
    const revoked = await fixture.decideSupportAccess(
      approved.id,
      "revoke",
      { expectedVersion: approved.version, reason: "Investigation complete" },
      "Maya Al-Salem",
    );
    assert.equal(revoked.state, "REVOKED");
    await assert.rejects(
      () => fixture.decideSupportAccess(revoked.id, "revoke", { expectedVersion: revoked.version, reason: "Again" }, "Maya Al-Salem"),
      (error) => error?.status === 409,
    );

    await assert.rejects(
      () => fixture.retryDelivery("16000000-0000-4000-8000-000000000004", "Maya Al-Salem"),
      (error) => error?.status === 400 && /not retryable/u.test(error.message),
    );
    await fixture.retryDelivery("16000000-0000-4000-8000-000000000003", "Maya Al-Salem");
    assert.equal((await fixture.getDeliveryDetail("16000000-0000-4000-8000-000000000003")).state, "QUEUED");

    const versions = await fixture.getRuleSetVersions();
    const active = versions.find((row) => row.state === "ACTIVE");
    const draft = versions.find((row) => row.state === "DRAFT");
    const retired = versions.find((row) => row.state === "RETIRED");
    assert.ok(active && draft && retired);
    assert.equal((await fixture.getRuleSetReadiness(draft.id)).ready, true);
    const comparison = await fixture.compareRuleSetVersions(retired.id, active.id);
    assert.deepEqual(comparison.summary, { added: 1, removed: 0, changed: 2, unchanged: 0 });
    const changedRules = comparison.changes.filter((change) => change.kind === "CHANGED");
    assert.ok(changedRules.every((change) => change.fieldDiffs.length > 0));
    assert.ok(changedRules.every((change) => change.fieldDiffs.some((field) => field.key === "savedExamples")));
    const equivalentSnapshots = await fixture.compareRuleSetVersions(active.id, draft.id);
    assert.deepEqual(equivalentSnapshots.summary, { added: 0, removed: 0, changed: 0, unchanged: 3 });
    const activated = await fixture.activateRuleSetVersion(draft.id, {
      expectedRevision: draft.revision,
      expectedActiveRuleSetId: active.id,
      expectedActiveRevision: active.revision,
    }, "Maya Al-Salem");
    assert.equal(activated.result.state, "ACTIVE");
    const rolledBack = await fixture.rollbackRuleSetVersion(retired.id, {
      expectedSourceRevision: retired.revision,
      expectedActiveRuleSetId: draft.id,
      expectedActiveRevision: draft.revision,
    }, "Maya Al-Salem");
    assert.equal(rolledBack.result.state, "ACTIVE");
    assert.equal(rolledBack.result.rollbackSourceRuleSetId, retired.id);

    const activeRuleCount = (await fixture.getDashboardData()).rules.length;
    const createdId = await fixture.createRule({
      name: "Return authorization",
      matcherType: "prefix_length",
      pattern: "\\bRET\\d{7}\\b",
      prefix: "RET",
      digitLength: 7,
      priority: 10,
      enabled: true,
      savedExamples: [{
        name: "Creation validation",
        message: "Return RET1234567",
        expectedMatches: ["RET1234567"],
      }],
    }, "Maya Al-Salem");
    const created = (await fixture.getRuleSetVersions()).find((row) => row.id === createdId);
    assert.equal(created?.state, "DRAFT");
    assert.equal(created?.rules?.[0]?.savedExamples?.[0]?.expectedMatches?.[0], "RET1234567");
    assert.equal((await fixture.getDashboardData()).rules.length, activeRuleCount, "a draft must not leak into the active dashboard projection");
  } finally {
    if (previousBackend === undefined) delete process.env.PORTAL_DATA_BACKEND;
    else process.env.PORTAL_DATA_BACKEND = previousBackend;
    if (previousRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE;
    else process.env.PORTAL_FIXTURE_ROLE = previousRole;
  }
});

test("rule comparison exposes every material field change and ignores snapshot-only IDs", async () => {
  const { describeRuleChange } = await import("../lib/rule-version-diff.ts");
  const fields = describeRuleChange({
    before: {
      id: "rule-v2", name: "Shipment reference", matcherType: "prefix_length",
      pattern: "ABC[0-9]{7}", matcherOptions: { prefix: "ABC", digitLength: 7 },
      priority: 2, enabled: true,
      savedExamples: [{ name: "Positive", message: "ABC1234567", expectedMatches: ["ABC1234567"] }],
    },
    after: {
      id: "rule-v3", name: "Shipment identifier", matcherType: "starts_with",
      pattern: "SHIP-", matcherOptions: {}, priority: 1, enabled: false,
      savedExamples: [{ name: "Positive", message: "SHIP-42", expectedMatches: ["SHIP-42"] }],
    },
  });
  assert.deepEqual(fields.map((field) => field.key), [
    "name", "matcherType", "pattern", "matcherOptions", "priority", "enabled", "savedExamples",
  ]);
  assert.match(fields.find((field) => field.key === "priority")?.summary ?? "", /Priority 2 → 1/u);
  assert.match(fields.find((field) => field.key === "enabled")?.summary ?? "", /State Enabled → Disabled/u);
  assert.match(fields.find((field) => field.key === "savedExamples")?.summary ?? "", /content updated: Positive/u);
  assert.deepEqual(describeRuleChange({
    before: { id: "rule-v3", name: "Same", matcherType: "exact_length", pattern: "[0-9]{10}", matcherOptions: { digitLength: 10, prefix: null }, priority: 1, enabled: true, savedExamples: [] },
    after: { id: "rule-v4", name: "Same", matcherType: "exact_length", pattern: "[0-9]{10}", matcherOptions: { digitLength: 10 }, priority: 1, enabled: true, savedExamples: [] },
  }), []);
});

test("portal UX has no dead operational controls and keeps sensitive content fail-closed", async () => {
  const [app, css, page, rulesRoute, messages] = await Promise.all([
    readTenantPortalSource(),
    read("app/globals.css"),
    read("app/app/page.tsx"),
    read("app/api/rules/route.ts"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);

  assert.match(app, /fetch\(`\/api\/audit\/export\?\$\{query\}`/u);
  assert.match(app, /response\.blob\(\)/u);
  assertLocalizedCopy(app, messages, "tenant.support.originNote", "Support requests originate in the separately authenticated WasalX operator console. Tenant sessions cannot create their own support approval.");
  assertLocalizedCopy(app, messages, "tenant.support.actions.approveEllipsis", "Approve metadata access…");
  assert.match(app, /setAction\("deny"\)/u);
  assert.match(app, /setAction\("revoke"\)/u);
  assert.match(app, /fetch\("\/api\/groups\/bulk-toggle"/u);
  assert.match(app, /result\.failed/u);
  assertLocalizedCopy(app, messages, "tenant.notifications.title", "Operational notifications");
  assertDictionaryCopy(messages, "tenant.notifications.count", "{count} operational notifications");
  assertDictionaryCopy(messages, "tenant.notifications.countOne", "{count} operational notification");

  assert.doesNotMatch(app, /row\.excerpt/u);
  assertLocalizedCopy(app, messages, "tenant.deliveries.contentRedacted", "Message content redacted");
  assertDictionaryCopy(messages, "tenant.deliveries.automaticRetry", "WasalX will retry automatically when it is safe to send.");
  assert.match(app,/deliveryRetriesAutomatically\(row\.state\)\?"tenant\.deliveries\.automaticRetry":"tenant\.errors\.deliveryReview"/u);
  assert.match(app,/deliveryRetriesAutomatically\(detail\.state\)\?"tenant\.deliveries\.automaticRetry":"tenant\.errors\.deliveryReview"/u);
  assert.match(app,/\[\["disconnected", "stopped", "logged_out"\], "common\.status\.disconnected"/u);
  assert.match(app,/\[\["awaiting_auth", "scan_qr_code", "pairing_code_required", "passkey_required", "passkey_confirmation_required", "action"\], "tenant\.status\.actionRequired"/u);
  assert.match(app,/\[\["connecting", "starting"\], "tenant\.status\.connecting"/u);
  assert.match(app,/\[\["degraded"\], "tenant\.status\.degraded"/u);
  assert.match(app, /purpose: "OPERATIONAL_REVIEW", confirmation: "REVEAL"/u);
  assert.match(app, /String\(row\.state\) === "FAILED_TERMINAL" && row\.manual_retry_allowed === true/u);
  assert.match(app, /inspect \? <button className="button small secondary"/u);
  assert.match(app, /inspect\(String\(row\.id\)\)/u);

  assert.match(app, /safeTestCurrent/u);
  assert.match(app, /disabled=\{!form\.name\.trim\(\) \|\| !safeTestCurrent \|\| saving\}/u);
  assert.match(app, /savedExamples: \[\{/u);
  assert.match(app, /t\(rows\.length \? "tenant\.rules\.activeSet" : "tenant\.rules\.noActiveSet"\)/u);
  assertDictionaryCopy(messages, "tenant.rules.activeSet", "Active rule set");
  assertDictionaryCopy(messages, "tenant.rules.noActiveSet", "No active rule set");
  assertLocalizedCopy(app, messages, "tenant.rules.noActiveSetBody", "Create and activate a governed version before assigning groups.");
  assert.doesNotMatch(app, /Production · version 3/u);
  assert.match(app, /RuleGovernanceDialog/u);
  assert.match(app, /\/api\/rule-sets\/compare/u);
  assert.match(app, /describeRuleChange\(change\)/u);
  assert.match(app, /fields\.map\(\(field\) => <li key=\{field\.key\}><bdi>\{field\.summary\}<\/bdi><\/li>\)/u);
  assert.match(app, /t\(kind === "UNCHANGED" && change\.kind === "CHANGED" \? "tenant\.rules\.comparison\.noMaterialChanges"/u);
  assertDictionaryCopy(messages, "tenant.rules.comparison.noMaterialChanges", "No material field changes");
  assert.match(css, /\.rule-change-evidence li\{[^}]*overflow-wrap:anywhere/u);
  assert.match(app, /expectedActiveRuleSetId/u);
  assert.match(app, /aria-label=\{t\("tenant\.rules\.inspectNamed", \{ name: rule\.name \}\)\}/u);
  assertDictionaryCopy(messages, "tenant.rules.inspectNamed", "Inspect {name}");
  assert.match(rulesRoute, /import type \{ TriggerRule \}/u);
  assert.doesNotMatch(rulesRoute, /compileRule|re2-wasm/u);
  assert.match(rulesRoute, /request\.headers\.get\("idempotency-key"\)/u);
  assert.match(rulesRoute, /Advanced expression creation requires the Node control plane/u);

  assert.match(app, /window\.history\[replace \? "replaceState" : "pushState"\]/u);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*const restore = \(event\?: PopStateEvent\) => \{/u);
  assert.match(app, /ref=\{pageHeadingRef\} tabIndex=\{-1\}/u);
  assert.match(app, /if \(event && next !== view\) focusPageHeading\(\)/u);
  assert.match(app, /if \(viewChanged \|\| mobileNavigationOpen\) focusPageHeading\(\)/u);
  assert.match(app, /<Audit rows=\{liveData\.audit\} showDiagnostics=\{role === "auditor"\} canExport=\{canExportAudit\}/u);
  assert.match(app, /action: friendlyAuditAction\(action, t\)/u);
  assert.doesNotMatch(app, /action: showDiagnostics \? label\(action\)/u);
  assert.match(app, /"WORKSPACE_USER", "WORKSPACE_AGENT"/u);
  assert.match(app, /\{canExport \? <button className="button secondary"/u);
  assert.match(app, /if \(tenantRole\) return <TenantWasalXApp/u);
  assert.doesNotMatch(app, /user\.role \?\? "tenant_owner"|isTenantRole\(user\.role\) \? user\.role : "tenant_owner"/u);
  assert.match(app, /useState\(\(\) => visibleNavigation\.some\(\(\[id\]\) => id === initialView\) \? initialView : "overview"\)/u);
  assert.match(page, /initialView=\{initialView\}/u);
  assert.match(page, /role: String\(dashboard\.tenant\.role \?\? ""\)/u);
  assert.match(app, /href=\{id === "overview" \? "\/app" : `\/app\?view=\$\{encodeURIComponent\(id\)\}`\}/u);
  assert.match(app, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/u);
  assert.match(app, /<LocaleSwitcher className="top-locale-switcher"/u);
  assert.match(css, /\.sidebar nav :is\(button,a\)/u);
  assert.match(css, /\.top-locale-switcher \.wx-button\[aria-pressed="true"\]\{display:none\}/u);
  assert.match(app, /fetch\("\/api\/dashboard", \{ cache: "no-store"/u);
  assert.doesNotMatch(app, /useVisibleRefresh\(\(\) => \{[\s\S]{0,300}router\.refresh\(\)/u);
  assert.match(app, /window\.addEventListener\("popstate"/u);
  assert.match(app, /const title = TENANT_VIEW_TITLES\[view\]/u);
  assert.match(app, /const localizedTitle = \[t\(title\[0\]\), t\(title\[1\]\)\] as const/u);
  assert.doesNotMatch(app, /<title>\{`\$\{localizedTitle\[0\]\} · WasalX`\}<\/title>/u);
  assert.doesNotMatch(app, /<title>/u);
  assert.match(app, /data-application-ready=\{shellValidationState==="ready"\?"true":"false"\}/u);
  assert.doesNotMatch(app, /MutationObserver/u);
  assert.match(app, /document\.title = `\$\{documentTitle\} · WasalX`/u);
  assert.match(app, /if \(!tenantRole\) document\.title = `\$\{t\("tenant\.boundary\.error\.heading"\)\} · WasalX`/u);
  assert.match(page, /translate\(tenantViewTitle\(requested\)\[0\]\)/u);
  assertDictionaryCopy(messages, "tenant.navigation.overview", "Overview");
  assert.match(app, /window\.localStorage\.getItem\("wasalx\.theme"\)/u);
  assert.match(app, /window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/u);
  assert.match(app, /rememberBoundaryTheme\("tenant",next\)/u);
  assert.match(css, /@media\(max-width:760px\).*\.top-actions \.icon-button\{display:grid\}/su);
  assert.match(css, /@media\(max-width:760px\).*\.workspace-switcher\{[^}]*grid-column:1;[^}]*grid-row:1;[^}]*min-width:0/u);
  assert.match(css, /@media\(max-width:760px\).*\.profile\{[^}]*grid-template-columns:auto auto/su);
  assert.match(css, /@media\(max-width:760px\).*\.profile-logout\{display:grid;width:44px;height:44px/su);
  assert.match(css, /@media\(max-width:760px\).*\.environment\{display:flex;/su);
  assert.match(css, /@media\(max-width:760px\).*nav\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*overflow-y:auto/su);
  assert.match(app, /className="button primary connect-number-action"[\s\S]*aria-label=\{t\("tenant\.connections\.connect"\)\}/u);
  assertDictionaryCopy(messages, "tenant.connections.connect", "Connect number");
  assert.match(app, /const isDuplicateIdentityRejection/u);
  assert.match(app, /titleKey: "tenant\.connection\.guidance\.duplicateRemoved\.title"/u);
  assert.match(app, /bodyKey: "tenant\.connection\.guidance\.duplicateRemoved\.body"/u);
  assert.match(app, /\{t\(guidance\.titleKey\)\}/u);
  assert.match(app, /\{t\(guidance\.bodyKey\)\}/u);
  assertDictionaryCopy(messages, "tenant.connection.guidance.duplicateRemoved.title", "Duplicate connection removed");
  assertDictionaryCopy(messages, "tenant.connection.guidance.duplicateRemoved.body", "The extra linked connection was removed. Continue using the existing working connection for this WhatsApp account.");
  assertLocalizedCopy(app, messages, "tenant.connection.lifecycle.duplicateDisabled", "Recovery controls are disabled for this rejected duplicate. Use the existing working connection.");
  assert.match(app, /updated=\{reconcileConnection\}/u);
  assert.match(app, /setDetail\(nextDetail\);\s*updated\(nextDetail\);/u);
  assert.match(app, /!isDuplicateIdentityRejection\(connection\.action_reason\)/u);
  assert.match(app, /!isDuplicateIdentityRejection\(c\.action_reason\)/u);
  assert.match(app, /!isDuplicateIdentityRejection\(row\.action_reason\)/u);
  assert.match(css, /@media\(max-width:760px\).*\.top-actions>\.connect-number-action\{display:inline-grid;width:44px;min-width:44px;height:44px;min-height:44px;padding:0\}/su);
  assert.match(css, /@media\(any-pointer:coarse\)\{:is\(button:not\(\.switch\),input:where\(:not\(\[type="hidden"\]\):not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\),select,textarea[^}]*min-block-size:44px/u);
  assert.match(css, /@media\(any-pointer:coarse\).*\.modal-head>button.*min-inline-size:44px/su);
  assert.match(css, /th,td,td small,\.status,[^\n]+font-size:var\(--wx-font-size-1\)/u);
  assert.doesNotMatch(css, /font-size:(?:9|10|11)px|font:(?:500|550|600|650) (?:9|10|11)px|font:9px/u);
  assert.doesNotMatch(css, /\.top-actions>\.button\.primary\{display:none\}/u);
});

test("tenant dialogs share one keyboard-focus contract without weakening confirmations", async () => {
  const [app, modal, css, tokens, messages] = await Promise.all([
    readTenantPortalSource(),
    read("app/ModalDialog.tsx"),
    read("app/globals.css"),
    read("app/design-system/tokens.css"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.equal((app.match(/<dialog\b/gu) ?? []).length, 0, "tenant surfaces must delegate native dialog behavior");
  assert.equal((modal.match(/<dialog\b/gu) ?? []).length, 1, "only ModalDialog may render a native dialog");
  assert.equal((app.match(/<ModalDialog\b/gu) ?? []).length, 19, "every tenant dialog surface must use ModalDialog");
  for (const accessibleName of [
    'aria-labelledby="invite-member-title"',
    'aria-labelledby="create-rule-title"',
    'aria-labelledby="reveal-message-title"',
    'aria-labelledby="delivery-detail-title"',
    'aria-labelledby="review-detail-title"',
  ]) {
    assert.ok(app.includes(accessibleName), `${accessibleName} must remain exposed by a managed dialog`);
  }
  assert.match(app, /aria-label=\{t\("tenant\.deliveries\.review\.deliveryOutcome\.retryLabel"\)\}/u);
  assertDictionaryCopy(messages, "tenant.deliveries.review.deliveryOutcome.retryLabel", "Confirm delivery retry");
  assert.match(modal, /export function ModalDialog/u);
  assert.match(app, /data-modal-initial-focus/u);
  assert.match(modal, /modal\.showModal\(\)/u);
  assert.match(modal, /onCancel=\{\(event\) => \{/u);
  assert.match(modal, /if \(event\.defaultPrevented\) return;/u);
  assert.match(modal, /onClose=\{/u);
  assert.match(modal, /close\(\);/u);
  assert.match(modal, /modal\.addEventListener\("keydown", retainFocus\)/u);
  assert.match(modal, /modal\.removeEventListener\("keydown", retainFocus\)/u);
  assert.match(modal, /event\.key === "Escape"[\s\S]*closeRef\.current\(\)/u);
  assert.doesNotMatch(modal, /document\.addEventListener\("keydown"/u);
  assert.match(modal, /restoreIsolation = isolateSiblings\(modal, document\.body\)/u);
  assert.match(modal, /closedby: "closerequest"/u);
  assert.match(modal, /\.modal-actions \.secondary:not\(:disabled\)/u);
  assert.doesNotMatch(modal, /fallbackLightDismiss/u);
  assert.match(modal, /previousFocus\?\.isConnected[\s\S]{0,100}document\.querySelector<HTMLElement>\("main h1"\)/u);
  assert.match(modal, /if \(target\?\.isConnected\) target\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(modal, /export function InlineConfirmation/u);
  assert.match(modal, /data-inline-confirm-initial-focus/u);
  assert.match(modal, /confirmation\.closest\("dialog"\) \?\? document\.body/u);
  assert.match(modal, /sibling\.inert = true/u);
  assert.match(modal, /aria-modal="true"[\s\S]*role="alertdialog"/u);
  assert.match(modal, /busy\?: boolean/u);
  assert.match(modal, /aria-busy=\{busy \|\| undefined\}/u);
  assert.match(modal, /if \(!busyRef\.current\) cancelRef\.current\(\)/u);
  assert.match(modal, /document\.activeElement instanceof HTMLButtonElement[\s\S]{0,100}document\.activeElement\.disabled/u);
  for (const busyConfirmation of ["operating", "pending", "saving"]) {
    assert.match(app, new RegExp(`<InlineConfirmation busy=\\{${busyConfirmation}\\}`));
  }
  assert.match(app, /const loadFence=useRef\(createLatestRequestFence\(\)\);[\s\S]{0,600}\/api\/deliveries/u);
  assert.match(app, /const loadFence=useRef\(createLatestRequestFence\(\)\);[\s\S]{0,600}\/api\/reviews/u);
  assert.match(app, /<InlineConfirmation/gu);
  assert.match(css, /\.modal-backdrop\{[^}]*border:0;[^}]*background:transparent/u);
  assert.match(css, /\.modal-backdrop:not\(\[open\]\)\{display:none\}/u);
  assert.match(app, /className="modal-backdrop group-configuration-backdrop"/u);
  assert.match(css, /\.group-configuration-backdrop \.group-drawer\{[^}]*width:min\(920px,100%\);height:min\(90dvh,960px\);max-height:90dvh/u);
  assert.match(css, /\.modal-backdrop::backdrop\{[^}]*background:var\(--overlay\);[^}]*backdrop-filter:blur\(6px\)/u);
  assert.match(tokens, /--wx-color-overlay: rgb\(0 0 0 \/ 72%\)/u);
  assert.match(css, /\.theme-dark \.modal\{border-color:color-mix\(in srgb,var\(--border-strong\) 78%,var\(--text\)\)\}/u);
  assert.match(css, /\.modal\{[^}]*box-shadow:var\(--shadow\)/u);
  assert.match(css, /@media\(forced-colors:active\)\{\.modal\{border-color:CanvasText;box-shadow:none\}/u);
  assert.match(app, /resolutionCode:"DELIVERY_RETRY_REQUESTED",confirmation:actionRetryConfirmation/u);
  assert.match(app, /setConfirmActionRetry\(false\);window\.requestAnimationFrame\(\(\)=>actionRetryTrigger\.current\?\.focus\(\)\)/u);
  assert.match(app, /purpose: "OPERATIONAL_REVIEW", confirmation: "REVEAL"/u);
});

test("tenant identity and provider visuals stay bidi-safe and token-driven", async () => {
  const [app, cases, css] = await Promise.all([
    readTenantPortalSource(),
    read("app/CaseLifecycle.tsx"),
    read("app/globals.css"),
  ]);
  assert.match(app, /<bdi dir="auto">\{user\.displayName\}<\/bdi>/u);
  assert.match(cases, /<bdi dir="auto">\{row\.group_name\}<\/bdi>/u);
  for (const token of [
    "--wx-color-brand-start",
    "--wx-color-brand-end",
    "--wx-color-provider-waha",
    "--wx-color-provider-meta",
    "--wx-color-qr-surface",
  ]) assert.ok(css.includes(`var(${token})`), `${token} must drive its tenant surface`);
  assert.doesNotMatch(css, /#a595ff|#6650db|#22a06b|border:8px solid #fff/u);
});

test("dense operational tables are contained inside their own mobile scrollers", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.content \{[^}]*width:100%;[^}]*min-width:0;[^}]*overflow-x:clip;/u);
  assert.match(css, /\.content>\* \{ min-width:0; max-width:100%; \}/u);
  assert.match(css, /\.panel \{ min-width:0; max-width:100%;/u);
  assert.match(css, /\.table-scroll\{position:relative;width:100%;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;overscroll-behavior-inline:contain;scrollbar-gutter:stable\}/u);
  assert.match(css, /\.table-scroll:focus-visible\{/u);
  assert.match(css, /\.table-scroll-cue\{/u);
});

test("large tenant workspaces load only when their route is selected", async () => {
  const [source, sharedUi] = await Promise.all([read("app/WasalXApp.tsx"), read("app/tenant-ui.tsx")]);
  const portal = readTenantPortalSource();
  const viewModules = ["BotAutomation", "ClientRouting", "CaseLifecycle", "InboxWorkspace", "SupportTeams", "MailboxAdministration",
    "WorkspaceAccess", "NativeRoutingSync", "MetaCostUsage", "MetaSignup", "MetaNumberRelease", "MetaTemplatePreparation", "MetaLegacyMigration",
    "MetaCoexistence", "MetaBillingDiagnostics", "MetaCustomerPaymentPolicy", "MetaRouting", "MetaSavedAccessActivation",
    "ConnectionDetail", "Groups", "TenantSettings", "Rules", "Deliveries", "Audit", "TeamAccess"];
  for (const moduleName of viewModules) {
    assert.match(portal, new RegExp(`lazy\\(async \\(\\) => \\([\\s\\S]*import\\(\\"\\./${moduleName}\\"\\)`));
    // The shell and its shared helpers are first-load; a static import there pulls the view back in.
    for (const firstLoad of [source, sharedUi]) {
      assert.doesNotMatch(firstLoad, new RegExp(`^import [^;]* from "\\./${moduleName}";`, "mu"), `${moduleName} must stay out of the first-load bundle`);
    }
  }
  assert.doesNotMatch(source, /import \{ CaseLifecycle \} from "\.\/CaseLifecycle"/u);
  assert.doesNotMatch(source, /import \{ BotAutomation, PluginCatalog \} from "\.\/BotAutomation"/u);
  assert.match(source, /<Suspense fallback=\{<WorkspaceLoading \/>\}>/u);
});

test("shared shell stays truthful, bounded, and operable on mobile", async () => {
  const [source, css, messages] = await Promise.all([
    readTenantPortalSource(),
    read("app/globals.css"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);
  assert.match(source, /const transportReady =/u);
  assert.match(source, /const inboundReady =/u);
  const guidance = source.match(/const guidanceState = ([\s\S]*?);/u)?.[1];
  assert.ok(guidance);
  const evaluate = new Function("state", "transportReady", "routingHeld", "detail", "inboundReady", `return (${guidance});`);
  for (const [state, transport, held, reason, inbound, expected] of [
    ["WORKING", false, true, "CONFIGURATION_REQUIRED", false, "VERIFYING"],
    ["WORKING", true, true, "CONFIGURATION_REQUIRED", true, "META_ROUTING_REQUIRED"],
    ["WORKING", true, true, "NEGATIVE_PENDING", true, "META_ROUTING_HELD"],
    ["WORKING", true, false, null, false, "AWAITING_INBOUND"],
    ["WORKING", true, false, null, true, "WORKING"],
    ["FAILED", false, true, "CONFIGURATION_REQUIRED", false, "FAILED"],
  ]) assert.equal(evaluate(state, transport, held, { meta_routing_reason: reason }, inbound), expected);
  assertDictionaryCopy(messages, "tenant.connection.guidance.verifying.title", "Verifying connection");
  assertDictionaryCopy(messages, "tenant.setup.providers.metaMeta", "Official one-to-one messaging");
  assert.doesNotMatch(messages, /groups when eligible/u);
  assert.match(source, /className="mobile-navigation-toggle"/u);
  assert.match(source, /data-mobile-navigation-open=\{mobileNavigationOpen\}/u);
  assert.match(source, /a\[href\],button:not\(\[disabled\]\),summary,select:not\(\[disabled\]\),input:not\(\[disabled\]\)/u);
  assert.match(source, /element\.tagName === "SUMMARY" && element\.parentElement === closedDetails/u);
  assert.match(css, /\.app-shell\[data-mobile-navigation-open="false"\] \.sidebar nav\{display:none\}/u);
  assert.match(css, /\.workspace-identity>b\{[^}]*-webkit-line-clamp:2;[^}]*overflow-wrap:anywhere;/u);
  assert.match(css, /\.operational-drawer-body>\*\{flex-shrink:0\}/u);
  assert.match(css, /@media\(max-width:480px\)\{[^@]*\.settings-nav:not\(\.settings-skeleton-nav\)\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(css, /\.profile-logout\{display:grid;width:44px;height:44px/u);
  assert.match(css, /\.modal-backdrop\[open\]\{display:grid;place-items:safe center\}/u);
  assert.match(css, /\.group-drawer\{[^}]*width:min\(720px,100%\);height:100%;max-height:100%/u);
  assert.match(css, /\.routing-combobox-options\{position:relative/u);
});

test("deliveries distinguish first use from an empty filter",async()=>{
  const [source,messages]=await Promise.all([readTenantPortalSource(),read("lib/i18n/messages/en/tenant.ts")]);
  assert.match(source,/filtered\.length \? <DeliveryTable[\s\S]*title=\{t\(rows\.length \? "tenant\.deliveries\.empty\.filteredTitle" : "tenant\.deliveries\.empty\.title"\)/u);
  assertDictionaryCopy(messages,"tenant.deliveries.empty.title","No message deliveries yet");
  assertDictionaryCopy(messages,"tenant.deliveries.empty.filteredTitle","No deliveries match this filter");
});

test("workflow assignment health includes every operational state",async()=>{
  const source=await read("app/BotAutomation.tsx");
  assert.match(source,/failed: "automation\.status\.failed"/u);
  assert.match(source,/normalized\.includes\("action_required"\) \|\| normalized\.includes\("degraded"\)/u);
});

test("routing does not claim no active version while older pages remain",async()=>{
  const source=await read("app/ClientRouting.tsx");
  assert.match(source,/hasLoaded && !error && !versionCursor && !versions\.some\(\(row\) => row\.state === "ACTIVE"\)/u);
});

test("runtime modes and rule governance projections cannot masquerade as production", async () => {
  const [app, bridge, vite, backend, messages] = await Promise.all([
    readTenantPortalSource(),
    read("lib/control-plane-data.ts"),
    read("vite.config.ts"),
    read("lib/backend.ts"),
    read("lib/i18n/messages/en/tenant.ts"),
  ]);

  assertLocalizedCopy(app, messages, "tenant.environment.previewOffline", "Sample workspace · no live operations");
  assertLocalizedCopy(app, messages, "tenant.preview.title", "Read-only sample workspace");
  assert.match(app, /const canConfigure = !isPrivateDemo/u);
  assert.match(app, /const canReadCases = !isPrivateDemo/u);
  assert.match(app, /canInspect=\{!isPrivateDemo\}/u);
  assert.doesNotMatch(app, /Hosted workspace/u);
  assert.match(bridge, /ruleSets\.filter\(\(set\) => set\.state === "ACTIVE"\)/u);
  assert.match(bridge, /rule\.matcherType \?\? rule\.matcher_type/u);
  assert.match(bridge, /rule\.matcherOptions \?\? rule\.matcher_options/u);
  assert.match(bridge, /savedExamples: input\.savedExamples \?\? \[\]/u);
  assert.match(bridge, /headers: \{ "idempotency-key": idempotencyKey \}/u);
  assert.match(vite, /nodejs_compat_populate_process_env/u);
  for (const name of [
    "PORTAL_DATA_BACKEND",
    "PORTAL_FIXTURE_ROLE",
    "CONTROL_API_URL",
    "PORTAL_PUBLIC_ORIGIN",
    "PORTAL_COOKIE_SECURE",
  ]) assert.match(vite, new RegExp(`\\["${name}"`, "u"));
  assert.match(backend, /"d1"\|"fixture"\|"control-plane"/u);
});

test("group commands are configured through the governed rule form without raw JSON",async()=>{
  const [app,styles,en,ar]=await Promise.all([readTenantPortalSource(),read("app/globals.css"),read("lib/i18n/messages/en/tenant.ts"),read("lib/i18n/messages/ar/tenant.ts")]);
  assert.match(app,/fetch\("\/api\/bot-flows\/actions",\{cache:"no-store"\}\)/u);
  assert.match(app,/groupCommand:\{actionId:form\.actionId,input:Object\.fromEntries/u);
  assert.match(app,/hasBotActionCapability\(row,"GROUP_COMMAND"\)/u);
  assert.doesNotMatch(app,/row\.kind==="HTTP_JSON"&&row\.http_method==="GET"/u);
  assert.match(app,/tenant\.rules\.command\.successReply/u);
  assert.match(app,/fetch\(`\/api\/groups\?limit=200&after=/u);
  assert.match(app,/testGroupNameCounts\.get\(name\)[\s\S]{0,240}tenant\.rules\.tester\.groupOptionDetailed/u);
  assertDictionaryCopy(en,"tenant.rules.tester.groupOptionDetailed","{name} · {connection} · {members} members");
  assert.match(styles,/\.rule-command-input\{display:grid/u);
  assert.match(styles,/\.rule-command-config \.check>span\{display:flex;min-width:0;flex-direction:column/u);
  for(const key of ["tenant.rules.command.title","tenant.rules.command.enable","tenant.rules.command.action","tenant.rules.command.successReply","tenant.rules.command.failureReply"]){assert.match(en,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));assert.match(ar,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"))}
});

test("plugins are a reusable workspace surface and direct flows expose a visual canvas",async()=>{
  const [app,bots,canvas,styles,en,ar]=await Promise.all([readTenantPortalSource(),read("app/BotAutomation.tsx"),read("app/WorkflowCanvas.tsx"),read("app/globals.css"),read("lib/i18n/messages/en/automation.ts"),read("lib/i18n/messages/ar/automation.ts")]);
  assert.match(app,/\["plugins", "tenant\.navigation\.plugins"/u);
  assert.match(app,/view === "plugins"[\s\S]*<PluginCatalog/u);
  assert.match(app,/view === "routing"[\s\S]*<ClientRouting/u);
  assert.match(bots,/export function PluginCatalog/u);
  assert.match(bots,/function groupActions\(rows: Row\[\]\)/u);
  assert.match(bots,/actionKey: row\.id \? originalKey : `\$\{pluginKey\}\.\$\{actionKey\}`/u);
  assert.match(bots,/fetch\("\/api\/bot-flows\/actions\/credential"/u);
  assert.match(bots,/fetch\("\/api\/client-routing\/integrations"/u);
  assert.match(bots,/plugins\.form\.connectedAccount/u);
  assert.match(bots,/href="\/app\?view=connections"/u);
  assert.match(bots,/type="password"/u);
  assert.doesNotMatch(bots,/placeholder="secret:\/\//u);
  assert.match(bots,/<WorkflowCanvas[\s\S]*definition=\{value\}[\s\S]*setDefinition=\{setValue\}/u);
  assert.match(bots,/scrollIntoView\(\{ behavior: "auto", block: "center" \}\)/u);
  assert.match(bots,/id="bot-flow-error"[\s\S]*role="alert"/u);
  assert.match(canvas,/change\.dragging !== true/u);
  assert.match(canvas,/onNodeDragStop=\{finishNodeDrag\}/u);
  assert.match(bots,/setPresentation\(\(current\) => \{[\s\S]*\.\.\.current\.nodePositions, \[nodeId\]: position/u);
  assert.match(bots,/wasalx:workflow-draft:\$\{workspaceId\}/u);
  assert.match(canvas,/<ReactFlow[\s\S]*nodesConnectable[\s\S]*nodesDraggable[\s\S]*nodesFocusable/u);
  assert.match(canvas,/<MiniMap pannable zoomable/u);
  assert.match(canvas,/reconnectWorkflowNode/u);
  assert.match(styles,/\.plugin-group/u);
  assert.match(styles,/\.workflow-canvas/u);
  for(const key of ["plugins.catalog.title","plugins.form.pluginKey","bot.canvas.title"]){assert.match(en,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));assert.match(ar,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"))}
});

test("Connections manages shared OAuth data-service bindings",async()=>{
  const [app,routing,visibleRefresh,bots,callback,enTenant,arTenant,enAutomation,arAutomation]=await Promise.all([
    readTenantPortalSource(),
    read("app/ClientRouting.tsx"),
    read("app/use-visible-refresh.ts"),
    read("app/BotAutomation.tsx"),
    read("app/api/client-routing/oauth/notion/callback/route.ts"),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
    read("lib/i18n/messages/en/automation.ts"),
    read("lib/i18n/messages/ar/automation.ts"),
  ]);
  assert.match(app,/const ConnectedDataServices = lazy\(async \(\) => \(\{[\s\S]*import\("\.\/ClientRouting"\)/u);
  assert.match(app,/<ConnectedDataServices canWrite=\{canConfigure\} mutationHeaders=\{mutationHeaders\} \/>/u);
  assert.match(routing,/export function ConnectedDataServices/u);
  assert.match(routing,/Promise\.all\(\[\s*?routingCapabilitiesData\(requestError, controller\.signal\),\s*?routingIntegrationData\(requestError, controller\.signal\)/u);
  assert.match(routing,/const sequence = \+\+loadSequence\.current;[\s\S]*loadController\.current\?\.abort\(\);[\s\S]*sequence === loadSequence\.current/u);
  assert.match(routing,/sourceSignal\?\.addEventListener\("abort", abortFromSource, \{ once: true \}\)/u);
  assert.match(routing,/if \(!isCurrent\(\)\) return;[\s\S]*setNotionOAuthEnabled/u);
  assert.match(routing,/routingCapabilitiesData\(requestError: \(status: number\) => string, signal\?: AbortSignal\)[\s\S]*cache: "no-store",\s*signal,/u);
  assert.match(routing,/routingIntegrationData\(requestError:\(status:number\)=>string,signal\?:AbortSignal\)[\s\S]*cache:"no-store",signal/u);
  assert.match(routing,/useVisibleRefresh\(\(signal\) => load\(true, signal\), !loading && !refreshing && !connecting\)/u);
  assert.match(visibleRefresh,/if\(document\.visibilityState!=="visible"\)[\s\S]*active\?\.abort\(\)/u);
  assert.match(routing,/fetch\("\/api\/client-routing\/integrations\/notion\/start"/u);
  assert.match(routing,/row\.id===hint\.integrationId&&row\.state==="CONNECTED"/u);
  assert.match(routing,/window\.sessionStorage\.setItem\(pendingDataConnectionKey,integrationId\)/u);
  assert.match(routing,/<ul className="data-connection-list">/u);
  assert.match(routing,/<bdi>\{integration\.display_name\}<\/bdi>/u);
  assert.match(routing,/routing\.integrations\.emptyReadOnly/u);
  assert.doesNotMatch(routing,/className="panel routing-integrations"/u);
  assert.match(routing,/integrations=\{integrations\}/u);
  assert.match(bots,/href="\/app\?view=connections" target="_blank" rel="noopener noreferrer"/u);
  assert.match(bots,/plugins\.form\.opensInNewTab/u);
  assert.match(callback,/destination\.searchParams\.set\("view","connections"\)/u);
  assert.match(callback,/destination\.searchParams\.set\("routingIntegration","refresh"\)/u);
  for(const key of ["tenant.connections.messagingTitle","tenant.connections.messagingHelp"]){
    assert.match(enTenant,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));
    assert.match(arTenant,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));
  }
  for(const key of ["plugins.form.opensInNewTab","routing.integrations.loading","routing.integrations.connectedWorkspace","routing.integrations.refresh","routing.integrations.reconnect","routing.integrations.recoveryConnecting","routing.integrations.recoveryRevoked","routing.integrations.emptyReadOnly","routing.errors.integrationStatus","routing.errors.integrationNotReady"]){
    assert.match(enAutomation,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));
    assert.match(arAutomation,new RegExp(`"${key.replaceAll(".","\\.")}":`,"u"));
  }
  assert.doesNotMatch(enAutomation,/Data workspace connections are not configured in this deployment/u);
  assert.doesNotMatch(arAutomation,/not configured in this deployment/u);
});

test("lazy slots in panels, drawers and dialogs use a compact, accurately labelled loading state", async () => {
  const source = readTenantPortalSource();
  const [english, arabic] = await Promise.all([
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  const views = ["Groups", "Rules", "BotAutomation", "PluginCatalog", "ClientRouting", "InboxWorkspace", "CaseLifecycle", "Deliveries", "TeamAccess", "Audit", "Settings"];
  const wrapped = (fallback) => [...source.matchAll(new RegExp(String.raw`<Suspense fallback=\{<${fallback}(?: quiet=\{!metaSectionLoaded\})? />\}>\s*(?:\{[^<]*)?<(\w+)`, "gu"))].map((match) => match[1]);
  assert.deepEqual(wrapped("WorkspaceLoading"), views, "WorkspaceLoading is only for whole views");
  const slots = wrapped("SectionLoading");
  for (const slot of ["MetaCostUsage", "SupportTeams", "MailboxAdministration", "ConnectedDataServices", "MetaNumberRelease", "MetaTemplatePreparation", "MetaSignup", "NativeRoutingSync", "WorkspaceAccess"]) {
    assert.ok(slots.includes(slot), `${slot} must load with the compact SectionLoading state`);
  }
  assert.equal(slots.filter((slot) => slot === "MetaSignup").length, 2, "the reconnect section and the add-connection dialog both stay compact");
  assert.match(source, /function SectionLoading\(\{ quiet = false \}: \{ quiet\?: boolean \}\) \{[\s\S]*?className="review-loading compact" role=\{quiet \? undefined : "status"\}>[\s\S]*?t\("tenant\.loading\.section"\)/u);
  assert.match(source, /function WorkspaceLoading\(\) \{[\s\S]*?className="review-loading workspace-loading" role="status">[\s\S]*?t\("tenant\.loading\.workspace"\)/u);
  for (const name of ["WorkspaceLoading", "SectionLoading"]) {
    const body = source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
    assert.doesNotMatch(body, /aria-busy|aria-live/u, `${name} is one plain status region; busy hides its announcement`);
  }
  // A revoked Meta connection loads number release beside the Meta section; only the Meta section announces,
  // unless the Meta section code is already cached and its slot does not suspend (#325).
  assert.deepEqual([...source.matchAll(/<Suspense fallback=\{<SectionLoading quiet=\{!metaSectionLoaded\} \/>\}>\s*<(\w+)/gu)].map((match) => match[1]), ["MetaNumberRelease"]);
  assert.match(source, /let metaSectionLoaded = false;\nconst MetaTemplatePreparation = lazy\(async \(\) => \{[^\n]*metaSectionLoaded = true;/u);
  assert.match(source, /detail\.provider === "META" \? \(\s*<Suspense fallback=\{<SectionLoading \/>\}>\s*\{!sessionExpired \? <MetaTemplatePreparation/u);
  // Skeleton loaders keep aria-busy on the skeleton and announce through one plain status inside it (#325).
  const skeletons = [readTenantPortalSource(), ...await Promise.all(["app/BotAutomation.tsx", "app/ClientRouting.tsx", "app/CaseLifecycle.tsx", "app/NativeRoutingSync.tsx"].map(read))].join("\n");
  assert.deepEqual([...skeletons.matchAll(/<\w+ [^>]*role="status"[^>]*>/gu)].map((match) => match[0]).filter((tag) => tag.includes("aria-busy")), [], "a live region is never busy");
  const statuses = [...skeletons.matchAll(/<\w+ className="[^"]*" aria-busy="true"><p className="sr-only" role="status" aria-label=\{t\("([\w.]+)"\)\}>\{t\("\1"\)\}<\/p>/gu)].map((match) => match[1]);
  assert.deepEqual(statuses, ["tenant.settings.loading", "tenant.privacy.loading", "tenant.privacy.detail.loading", "tenant.team.loading", "bot.flows.loadingDetail", "bot.conversations.loadingExecution", "plugins.loading", "bot.canvas.loading", "routing.detail.loading"]);
  assert.match(skeletons, /className="panel bot-loading"\s+aria-busy="true"\s*>\s*<p className="sr-only" role="status" aria-label=\{t\("bot\.loading"\)\}>/u);
  assert.match(skeletons, /className="panel bot-loading" aria-busy="true">\s*<p className="sr-only" role="status" aria-label=\{t\("routing\.loading"\)\}>\{t\("routing\.loading"\)\}<\/p>/u);
  assert.match(skeletons, /className=\{styles\.skeleton\} aria-busy="true"><p className="sr-only" role="status" aria-label=\{t\("cases\.loading"\)\}>\{t\("cases\.loading"\)\}<\/p>/u);
  assert.match(skeletons, /className="data-connections-loading" role="status">\{t\("routing\.integrations\.loading"\)\}/u);
  assert.match(skeletons, /aria-labelledby=\{titleId\} aria-busy=\{loading \|\| busy\}>/u);
  assert.match(skeletons, /<div role="status">\s*<b>\{t\(displayState \? `nativeRouting\.state/u);
  // Release simulations wait for the busy container, never a busy live region (#338).
  for (const simulation of ["simulation-remaining-quality", "simulation-shared-readonly", "simulation-routing-quality"]) {
    const script = await read(`scripts/release/${simulation}.mjs`);
    assert.doesNotMatch(script, /\[role=status\]\[aria-busy=true\]/u, `${simulation} waits for a busy live region`);
    assert.match(script, /\[aria-busy=true\]:has\(> \[role=status\]\)/u, `${simulation} waits for the busy loader`);
  }
  assert.match(english, /"tenant\.loading\.section": "Loading this section…"/u);
  assert.match(arabic, /"tenant\.loading\.section": "جارٍ تحميل هذا القسم…"/u);
});

test("decorative arrows follow the reading direction and stay hidden from screen readers", async () => {
  const [styles, ...sources] = await Promise.all([
    read("app/globals.css"),
    readTenantPortalSource(),
    read("app/BotAutomation.tsx"),
    read("app/platform/MetaTransitionOperator.tsx"),
  ]);
  assert.match(styles, /\.reading-arrow\{display:inline-block;vertical-align:-\.125em\}\.reading-arrow svg\{display:block;inline-size:1em;block-size:1em\}\[dir="rtl"\] \.reading-arrow svg\{transform:scaleX\(-1\)\}/u);
  for (const source of sources) {
    // Arrows are the icon set's drawn arrow (#326), never a text character that changes with the font.
    assert.doesNotMatch(source, /[\u2190\u2192]/u, "no text arrows");
    const arrows = source.split('className="reading-arrow"').length - 1;
    assert.ok(arrows > 0);
    assert.equal(source.split('<span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span>').length - 1, arrows, "every arrow is a mirrored, aria-hidden drawn reading-arrow");
  }
});
