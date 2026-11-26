import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("app/BotAutomation.tsx", root), "utf8");
const english = await readFile(new URL("lib/i18n/messages/en/automation.ts", root), "utf8");
const arabic = await readFile(new URL("lib/i18n/messages/ar/automation.ts", root), "utf8");
const qualificationStartProxy = await readFile(new URL("app/api/bot-flows/actions/[actionKey]/qualifications/route.ts", root), "utf8");
const qualificationStatusProxy = await readFile(new URL("app/api/bot-flows/actions/[actionKey]/qualifications/[qualificationId]/route.ts", root), "utf8");
const revisionsProxy = await readFile(new URL("app/api/bot-flows/actions/[actionKey]/revisions/route.ts", root), "utf8");
const restoreProxy = await readFile(new URL("app/api/bot-flows/actions/[actionKey]/revisions/[revision]/restore/route.ts", root), "utf8");
const controlPlane = await readFile(new URL("lib/control-plane-data.ts", root), "utf8");
const service = await readFile(new URL("services/control-api/src/bot-flows.service.ts", root), "utf8");

test("plugin editor is a focus-restoring modal with a guarded dirty close", () => {
  assert.match(source, /<ModalDialog className="modal-backdrop" close=\{requestClose\} aria-labelledby="plugin-action-dialog-title">/u);
  assert.match(source, /const dirty = initialSnapshot !== JSON\.stringify/u);
  assert.match(source, /if \(dirty\) \{[\s\S]*setConfirmClose\(true\)/u);
  assert.match(source, /<InlineConfirmation[\s\S]*data-inline-confirm-initial-focus[\s\S]*plugins\.form\.discard/u);
  assert.match(source, /data-modal-initial-focus/u);
  assert.match(source, /data-modal-cancel/u);
});

test("plugin mutation failures preserve typed privileged recovery inside the open draft", () => {
  assert.match(source, /operatorResponseFailure, type CodedOperatorError/u);
  assert.match(source, /setMutationError\(operatorFailure\(problem, t\("bot\.errors\.change"\), locale\)\)/u);
  assert.match(source, /mutationError\.code === "REAUTHENTICATION_REQUIRED"/u);
  assert.match(source, /href="\/auth\/login\?step_up=privileged&return_to=%2Fapp%3Fview%3Dplugins"/u);
  assert.match(source, /target="_blank"[\s\S]*rel="noopener noreferrer"/u);
  assert.match(source, /<ActionForm[\s\S]*mutationError=\{mutationError\}/u);
  assert.match(source, /\{loadError \? <div[\s\S]*automation\.common\.reload/u);
  assert.doesNotMatch(source, /localStorage[\s\S]{0,240}credential|sessionStorage[\s\S]{0,240}credential/iu);
});

test("qualification uses the durable server contract and renders every safe outcome", () => {
  assert.match(source, /row\.qualification_supported === true/u);
  assert.match(source, /row\.state === "ACTIVE"[\s\S]*capabilities\.retry_semantics === "REPLAY_SAFE"/u);
  assert.match(source, /POST[\s\S]*expectedRevision: Number\(row\.active_action_revision \?\? row\.revision\)/u);
  assert.match(source, /bot-flows\/actions\/\$\{actionPath\}\/qualifications/u);
  assert.match(source, /qualifications\/\$\{encodeURIComponent\(queued\.qualificationId\)\}/u);
  assert.match(source, /qualificationPending && qualification\?\.qualificationId \? qualification : null/u);
  assert.match(source, /qualificationPending \? "plugins\.qualification\.checkStatus"/u);
  for (const outcome of ["SUCCESS", "ERROR", "TIMEOUT", "OUTCOME_UNKNOWN"]) {
    assert.match(source, new RegExp(`qualification\\.outcome === "${outcome}"`, "u"));
  }
  assert.doesNotMatch(source, /qualification\.safeError/u);
  assert.doesNotMatch(source, /eval\(|new Function\(/u);
  assert.match(source, /QUALIFICATION_POLL_HORIZON_MS = 75_000/u);
  assert.match(source, /document\.visibilityState !== "visible"/u);
  assert.match(source, /status === 408 \|\| status === 429 \|\| status >= 500/u);
  assert.match(source, /Math\.min\(pollDelay \* 2, QUALIFICATION_POLL_MAX_BACKOFF_MS\)/u);
  assert.match(source, /setQualificationError\(await operatorResponseFailure\(response,t\("plugins\.qualification\.failed"\)\)\)/u);
  assert.match(source, /qualificationError\.code==="REAUTHENTICATION_REQUIRED"[\s\S]*plugins\.form\.reauthenticate/u);
  assert.match(source, /<fieldset className="bot-form-wide">[\s\S]*bot\.actionForm\.headers[\s\S]*<fieldset className="bot-form-wide">[\s\S]*bot\.actionForm\.mapping/u);
  assert.match(source, /node\.priority==="1 low"\?"bot\.node\.low"[\s\S]*"bot\.node\.normal"/u);
});

test("qualification proxies preserve authorization, tenant session, and idempotency boundaries", () => {
  assert.match(qualificationStartProxy, /authenticatePortalRequest\(request,"bot:write"\)/u);
  assert.match(qualificationStartProxy, /request\.headers\.get\("idempotency-key"\)/u);
  assert.match(qualificationStatusProxy, /authenticatePortalRequest\(request,"bot:read"\)/u);
  assert.match(controlPlane, /qualifyBotAction[\s\S]*currentPortalSession\(\)[\s\S]*"idempotency-key":idempotencyKey/u);
  assert.match(controlPlane, /getBotActionQualification[\s\S]*currentPortalSession\(\)/u);
  assert.match(service, /WHERE job\.tenant_id=\$1 AND job\.id=\$2 AND job\.origin='QUALIFICATION' AND action\.action_key=\$3/u);
});

test("plugin history restores an immutable revision through a fenced new revision", () => {
  assert.match(source, /bot-flows\/actions\/\$\{encodeURIComponent\(originalKey\)\}\/revisions/u);
  assert.match(source, /revisions\/\$\{revision\}\/restore[\s\S]*expectedRevision/u);
  assert.match(source, /<InlineConfirmation[\s\S]*plugins\.history\.confirmTitle/u);
  assert.match(source, /revision\.active===true[\s\S]*plugins\.history\.current/u);
  assert.match(revisionsProxy, /authenticatePortalRequest\(request,"bot:read"\)/u);
  assert.match(revisionsProxy, /private, no-store/u);
  assert.match(restoreProxy, /authenticatePortalRequest\(request,"bot:write"\)/u);
  assert.match(restoreProxy, /request\.headers\.get\("idempotency-key"\)/u);
  assert.match(restoreProxy, /private, no-store/u);
  assert.match(service, /async restoreActionRevision[\s\S]*revision\.revision=\$3[\s\S]*this\.saveAction/u);
  assert.match(service, /bot_action\.restored[\s\S]*restored_from_revision/u);
});

test("server qualification is a real replay-safe job with redacted results", () => {
  assert.match(service, /qualification_supported:row\.state==="ACTIVE"&&capabilities\.retry_semantics==="REPLAY_SAFE"/u);
  assert.match(service, /action\.http_method!=="GET"[\s\S]*Only replay-safe GET actions can be qualified/u);
  assert.match(service, /qualification_idempotency_key=\$2/u);
  assert.match(service, /INSERT INTO bot_action_jobs[\s\S]*'QUALIFICATION'/u);
  assert.match(service, /state,outcome,[\s\S]*createdAt:row\.created_at/u);
  assert.doesNotMatch(service.match(/async getActionQualification[\s\S]*?\n {2}\}/u)?.[0] ?? "", /secret_reference|response_variables|request_input/u);
});

test("plugin qualification and discard copy is complete in English and Arabic", () => {
  for (const key of [
    "plugins.form.discardTitle",
    "plugins.form.keepEditing",
    "plugins.form.reauthenticate",
    "plugins.qualification.help",
    "plugins.qualification.unavailable",
    "plugins.qualification.inProgress",
    "plugins.qualification.checkStatus",
    "plugins.qualification.success",
    "plugins.qualification.failed",
    "plugins.qualification.timeout",
    "plugins.qualification.unknown",
    "plugins.qualification.statusUnavailable",
    "plugins.history.title",
    "plugins.history.current",
    "plugins.history.restore",
    "plugins.history.confirmTitle",
    "plugins.history.confirmBody",
    "plugins.history.confirm",
    "plugins.history.restored",
  ]) {
    const keyPattern = new RegExp(`"${key.replaceAll(".", "\\.")}":`, "u");
    assert.match(english, keyPattern);
    assert.match(arabic, keyPattern);
  }
});
