import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createInvitationOidcTransaction,
  InvitationRequestTooLargeError,
  readBoundedInvitationRequest,
  validInvitationToken,
  validInvitationTransaction,
} from "../lib/invitation-oidc.ts";

test("invitation acceptance accepts only canonical 256-bit base64url tokens", async () => {
  const token = "A".repeat(43);
  assert.equal(validInvitationToken(token), true);
  for (const invalid of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, "token with spaces"]) {
    assert.equal(validInvitationToken(invalid), false);
  }
  const { transaction, challenge } = await createInvitationOidcTransaction(token);
  assert.equal(transaction.kind, "tenant_invitation");
  assert.equal(validInvitationTransaction(transaction), true);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(validInvitationTransaction({ ...transaction, createdAt: Date.now() - 11 * 60_000 }), false);
});

test("browser handoff reads the token from the fragment and removes it before OIDC navigation", async () => {
  const component = await source("../app/invitations/accept/InvitationAcceptance.tsx");
  const mailer = await source("../services/invitation-mailer/src/provider.ts");
  assert.match(mailer, /url\.hash = `token=/);
  assert.doesNotMatch(mailer, /searchParams\.set\([^\n]*token/);
  assert.match(component, /window\.location\.hash/);
  assert.match(component, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
  assert.match(component, /window\.location\.assign\(result\.authorizeUrl\)/);
  assert.match(component, /credentials: "same-origin"/);
  assert.match(component, /window\.addEventListener\("hashchange", handleHashChange\)/u);
  assert.match(component, /const requestController = new AbortController\(\)/u);
  assert.match(component, /cancelled \|\| current !== generation \|\| requestController\.signal\.aborted/u);
  assert.match(component, /controller\?\.abort\(\)/u);
});

test("invitation start is control-plane only, same-origin, no-store, short-lived, and HttpOnly", async () => {
  const route = await source("../app/api/invitations/accept/start/route.ts");
  const oidc = await source("../lib/invitation-oidc.ts");
  assert.match(route, /isControlPlaneBackend\(\)/);
  assert.match(route, /request\.headers\.get\("origin"\) !== portalPublicOrigin\(\)/);
  assert.match(route, /httpOnly: true/);
  assert.match(route, /sameSite: "lax"/);
  assert.match(route, /maxAge: OIDC_TRANSACTION_MAX_AGE_SECONDS/);
  assert.match(route, /cache-control", "no-store"/);
  assert.match(route, /referrer-policy", "no-referrer"/);
  assert.match(route, /readBoundedInvitationRequest\(request\)/);
  assert.match(oidc, /readBoundedBody\(request, maximumBytes, timeoutMs\)/);
  assert.match(oidc, /error instanceof BoundedBodyError && error\.status === 413/);
  assert.match(route, /!body \|\| typeof body !== "object" \|\| Array\.isArray\(body\)/);
  assert.doesNotMatch(route, /request\.text\(\)/);
});

test("invitation start body limit cancels an oversized stream before accumulation", async () => {
  const accepted = new Request("https://portal.example.com/api/invitations/accept/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "A".repeat(43) }),
  });
  assert.equal(
    await readBoundedInvitationRequest(accepted),
    JSON.stringify({ token: "A".repeat(43) }),
  );

  let cancelled = false;
  const oversized = new Request("https://portal.example.com/api/invitations/accept/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(400));
        controller.enqueue(new Uint8Array(113));
      },
      cancel() { cancelled = true; },
    }),
    duplex: "half",
  });
  await assert.rejects(
    readBoundedInvitationRequest(oversized),
    (error) => error instanceof InvitationRequestTooLargeError,
  );
  assert.equal(cancelled, true);
  assert.equal(oversized.body.locked, false);
});

test("invitation start stops stalled streams and releases their reader", async () => {
  let cancelled = false;
  const request = new Request("https://portal.example.com/api/invitations/accept/start", {
    method: "POST",
    body: new ReadableStream({ cancel() { cancelled = true; } }),
    duplex: "half",
  });
  await assert.rejects(readBoundedInvitationRequest(request, 25), /timed out/);
  assert.equal(cancelled, true);
  assert.equal(request.body.locked, false);
});

test("OIDC invitation flow proves fresh MFA before accepting membership", async () => {
  const sourceText = await source("../lib/invitation-oidc.ts");
  assert.match(sourceText, /prompt: "login"/);
  assert.match(sourceText, /max_age: "0"/);
  assert.match(sourceText, /code_challenge_method: "S256"/);
  assert.match(sourceText, /OIDC_INVITATION_REDIRECT_URI/);
  const verificationPosition = sourceText.indexOf("await verifyIdToken(");
  const mfaPosition = sourceText.indexOf("if (!verified.mfa)");
  const acceptPosition = sourceText.indexOf("await acceptInvitation(");
  const discoverPosition = sourceText.indexOf("await discover(");
  assert.ok(
    verificationPosition > 0 && mfaPosition > verificationPosition && acceptPosition > mfaPosition,
    "authoritative MFA must be verified before the invitation is consumed",
  );
  assert.ok(discoverPosition > acceptPosition, "tenant session discovery follows membership acceptance");
  assert.match(sourceText, /response\.status === 410[\s\S]*expired_or_used/);
  assert.match(sourceText, /response\.status === 403[\s\S]*identity_mismatch/);
  assert.match(sourceText, /response\.status === 401[\s\S]*identity_unverified/);
  assert.match(sourceText, /response\.status === 409[\s\S]*membership_conflict/);
  assert.match(sourceText, /JSON\.stringify\(\{ token, expectedSubject \}\)/);
  assert.match(sourceText, /attempt < 2/);
  assert.match(sourceText, /accepted_session_pending/);
});

test("callback clears the sealed one-time transaction on every terminal outcome", async () => {
  const callback = await source("../app/invitations/callback/route.ts");
  assert.match(callback, /clearTransaction\(response,state\)/);
  assert.match(callback, /maxAge: 0/);
  assert.match(callback, /InvitationAcceptanceError/);
  assert.match(callback, /deleteStoredPortalSession\(previousSessionId\)/);
  assert.doesNotMatch(callback, /console\.(?:log|error|warn)/);
  const result = await source("../app/invitations/result/page.tsx");
  for (const state of ["expired_or_used", "identity_mismatch", "identity_unverified", "membership_conflict", "authentication_failed"]) {
    assert.match(result, new RegExp(`${state}:`));
  }
  assert.doesNotMatch(result, /\baccepted(?:_session_pending)?:/u);
  assert.match(callback, /NextResponse\.redirect\(new URL\("\/app", portalPublicOrigin\(\)\)\)/u);
  assert.match(callback, /result === "accepted_session_pending"\s*\? "\/auth\/login\?return_to=\/app"/u);
  assert.match(callback, /membershipAccepted \? "accepted_session_pending"/);
});

test("invalid invitation fragments are scrubbed before presenting the error", async () => {
  const component = await source("../app/invitations/accept/InvitationAcceptance.tsx");
  assert.match(component, /if \(!token[^\n]+\{\s*window\.history\.replaceState\(null, "", window\.location\.pathname\);\s*setState\("invalid"\)/u);
});

test("pre-auth invitation screens use the approved public light theme and localized navigation", async () => {
  const shell = await source("../app/invitations/InvitationShell.tsx");
  assert.match(shell, /theme-light wx-design-system public-access-shell/u);
  assert.match(shell, /PublicHeader locale=\{locale\} copy=\{header\}/u);
});

async function source(relative) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}
