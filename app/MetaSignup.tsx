"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { MetaSignupAttemptView, MetaSignupCapabilities, MetaSignupStartResponse, MetaSignupVariant } from "../lib/meta-signup-contract";
import { launchMetaSignup, loadMetaSignupSdk } from "../lib/meta-signup-sdk";
import { localizedUiError } from "../lib/ui-error";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./MetaSignup.module.css";

const base = "/api/connections/meta/signup";

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string"
      && /^[A-Z_]{1,80}$/u.test(body.code) ? body.code : undefined;
    // Preserve typed reauthentication guidance, never provider messages or details.
    throw Object.assign(new Error("META_SIGNUP_REQUEST_FAILED"), { status: response.status, code });
  }
  return response.json() as Promise<T>;
}

type MetaSignupProps = {
  name: string; mutationHeaders: Record<string, string>; busyChanged: (busy: boolean) => void;
  created: (id: string) => void; back: () => void; manual?: () => void;
  isTargetConnectionRevoked?: () => boolean;
} & ({ target: { connectionId: string; name: string; canPrepare: boolean; canContinue: boolean; transitionId?: string; legacyMigrationId?: string }; purpose?: never }
  | { target?: undefined; purpose?: "NEW_NUMBER" | "ADD_ACCESS" });

export function MetaSignup(props: MetaSignupProps) {
  // A changed authenticated context or target owns a fresh component lifetime.
  // React keys stay in memory; no code, challenge or credential is persisted.
  return <MetaSignupSession key={`${props.target?.connectionId ?? props.purpose ?? "NEW_NUMBER"}:${props.target?.transitionId ?? ""}:${props.target?.legacyMigrationId ?? ""}:${props.mutationHeaders["x-wasalx-csrf"] ?? ""}`} {...props} />;
}

function MetaSignupSession({ name, mutationHeaders, busyChanged, created, back, manual, target, isTargetConnectionRevoked, purpose = "NEW_NUMBER" }: MetaSignupProps) {
  const { t, locale } = useI18n();
  const targetConnectionId = target?.connectionId;
  const transitionId = target?.transitionId;
  const legacyMigrationId = target?.legacyMigrationId;
  const legacy = Boolean(legacyMigrationId);
  const readback = Boolean(transitionId);
  const reconnect = Boolean(targetConnectionId);
  const addingAccess = !reconnect && purpose === "ADD_ACCESS";
  const latestPath = targetConnectionId ? `attempts?targetConnectionId=${encodeURIComponent(targetConnectionId)}${transitionId ? `&targetTransitionId=${encodeURIComponent(transitionId)}` : legacyMigrationId ? `&targetLegacyMigrationId=${encodeURIComponent(legacyMigrationId)}` : ""}` : addingAccess ? "attempts?purpose=ADD_ACCESS" : "attempts";
  const heading = useRef<HTMLHeadingElement>(null);
  const [variant, setVariant] = useState<MetaSignupVariant>("STANDARD");
  const [historyConsent, setHistoryConsent] = useState(false);
  const [contactsConsent, setContactsConsent] = useState(false);
  const [echoesConsent, setEchoesConsent] = useState(false);
  const [scopeMismatch, setScopeMismatch] = useState(false);
  const [capability, setCapability] = useState<MetaSignupCapabilities | null>(null);
  const [attempt, setAttempt] = useState<MetaSignupAttemptView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [waitingForMeta, setWaitingForMeta] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [authorizationPrepared, setAuthorizationPrepared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choiceId, setChoiceId] = useState("");
  const [pin, setPin] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const sdk = useRef<Awaited<ReturnType<typeof loadMetaSignupSdk>> | null>(null);
  const challenge = useRef<string | null>(null);
  const preparedSdk = useRef<MetaSignupStartResponse["sdk"] | null>(null);
  const disposePopupDiagnostics = useRef<(() => void) | null>(null);
  const current = useRef<MetaSignupAttemptView | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const popupOpen = useRef(false);
  const targetCanContinue = useRef(target?.canContinue !== false);
  useLayoutEffect(() => { targetCanContinue.current = target?.canContinue !== false; }, [target?.canContinue]);
  const startKey = useRef(crypto.randomUUID());
  const csrf = mutationHeaders["x-wasalx-csrf"];
  const headers = { "content-type": "application/json", ...(csrf ? { "x-wasalx-csrf": csrf } : {}) };
  const selectedVariant = !reconnect && !addingAccess && (attempt && !attempt.canStartAgain ? attempt.variant : variant) === "BUSINESS_APP";
  const selectable = (choice: MetaSignupAttemptView["choices"][number]) => choice.selectable
    && (legacy || readback ? choice.mode === "STANDARD" : selectedVariant ? choice.mode === "COEXISTENCE" && choice.numberState === "REGISTERED"
      : reconnect ? choice.mode === (attempt?.target?.mode ?? "STANDARD") && choice.numberState === "REGISTERED"
        : choice.mode === "STANDARD" && choice.numberState === (addingAccess ? "REGISTERED" : "REGISTRATION_REQUIRED"));
  const selected = !scopeMismatch && attempt?.nextAction === "SELECT_NUMBER"
    ? attempt.choices.find(choice => choice.choiceId === choiceId && selectable(choice)) : undefined;
  const needsPin = !reconnect && !addingAccess && !selectedVariant && selected?.numberState === "REGISTRATION_REQUIRED";
  const resumingSelection = Boolean(attempt?.connectionId && attempt.status === "SELECTION_REQUIRED");
  const pinValid = !needsPin || (resumingSelection && !pin) || /^\d{6}$/u.test(pin);

  function invalidateCallback() {
    generation.current++; disposePopupDiagnostics.current?.(); disposePopupDiagnostics.current = null;
  }

  function accept(view: MetaSignupAttemptView | null, expectedAttemptId?: string) {
    if (!alive.current) return;
    if ((legacy && readback) || (expectedAttemptId !== undefined && view?.attemptId !== expectedAttemptId) || (view && (targetConnectionId
      ? view.variant === "BUSINESS_APP" || view.purpose !== (legacy ? "LEGACY_MIGRATION" : readback ? "TRANSITION_READBACK" : "RECONNECT") || view.targetTransitionId !== transitionId || view.targetLegacyMigrationId !== legacyMigrationId
        || view.target?.connectionId !== targetConnectionId || (legacy ? !["PAUSED", "WORKING"].includes(view.target?.state ?? "") : view.target?.state !== "PAUSED")
        || (view.outcome !== undefined && view.outcome !== (legacy ? "MIGRATION_ACCESS_VERIFIED" : readback ? "READBACK_ACCESS_RENEWED" : "ACCESS_RENEWED_PAUSED"))
        || (view.connectionId !== undefined && view.connectionId !== targetConnectionId)
      : view.purpose !== purpose || view.target !== undefined || view.targetTransitionId !== undefined || view.targetLegacyMigrationId !== undefined
        || (view.outcome !== undefined && (!addingAccess || view.outcome !== "ACCESS_ADDED_PAUSED"))
        || (view.variant !== undefined && !["STANDARD", "BUSINESS_APP"].includes(view.variant))
        || (addingAccess && view.variant === "BUSINESS_APP")
        || (current.current?.attemptId === view.attemptId && (current.current.variant ?? "STANDARD") !== (view.variant ?? "STANDARD"))))) {
      invalidateCallback(); challenge.current = null; popupOpen.current = false;
      setAuthorizationPrepared(false); setWaitingForMeta(false); setScopeMismatch(true);
      inFlight.current = false; setPending(false); busyChanged(false);
      throw Object.assign(new Error("META_SIGNUP_SCOPE_CHANGED"), { code: "CONFLICT" });
    }
    if (view && current.current?.attemptId === view.attemptId && view.revision < current.current.revision) return;
    if (view?.selectionRevision !== current.current?.selectionRevision || view?.attemptId !== current.current?.attemptId) {
      setChoiceId(""); setPin("");
    }
    current.current = view;
    setAttempt(view);
  }

  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${base}/${path}`, { method: body === undefined ? "GET" : "POST",
      headers, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    return readResponse<T>(response);
  }

  async function refresh(signal?: AbortSignal) {
    if (inFlight.current) return;
    const version = generation.current;
    const id = current.current?.attemptId;
    const view = id
      ? await request<MetaSignupAttemptView>(`attempts/${encodeURIComponent(id)}`, undefined, signal)
      : (await request<{ attempt: MetaSignupAttemptView | null }>(latestPath, undefined, signal)).attempt;
    if (!signal?.aborted && version === generation.current && current.current?.attemptId === id) { accept(view, id); setUncertain(false); setError(null); }
  }

  // Effect events read the latest locale and props without restarting the session:
  // a locale change does not restart an authorization invocation.
  const loadSession = useEffectEvent(async (controller: AbortController) => {
    const loadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    try {
      const [capResponse, resumeResponse] = await Promise.all([
        fetch(`${base}/capabilities`, { cache: "no-store", signal: loadSignal }),
        fetch(`${base}/${latestPath}`, { cache: "no-store", signal: loadSignal }),
      ]);
      if (controller.signal.aborted) return;
      const [cap, resumed] = await Promise.all([readResponse<MetaSignupCapabilities>(capResponse),
        readResponse<{ attempt: MetaSignupAttemptView | null }>(resumeResponse)]);
      if (controller.signal.aborted) return;
      setCapability(cap);
      accept(resumed.attempt);
      setLoading(false);
      if (cap.enabled && cap.sdk) {
        sdk.current = await loadMetaSignupSdk(cap.sdk);
        if (!controller.signal.aborted) setSdkReady(true);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error && ["META_SIGNUP_CONFIGURATION", "META_SIGNUP_CONFIGURATION_CHANGED", "META_SIGNUP_SDK_UNAVAILABLE"].includes(failure.message)
          ? t(reconnect ? "tenant.metaSignup.reconnect.sdkUnavailable" : "tenant.metaSignup.sdkUnavailable") : localizedUiError(locale, failure).message);
        setLoading(false);
      }
    }
  });
  const leaveSession = useEffectEvent(() => {
    alive.current = false; invalidateCallback(); challenge.current = null; popupOpen.current = false;
    busyChanged(false);
    const leaving = current.current;
    // A late popup code is inert immediately. Cancellation additionally fences
    // it server-side; exchanged/provisioning work is resumed, never rolled back.
    if (isTargetConnectionRevoked?.() !== true && leaving?.status === "AWAITING_AUTHORIZATION" && leaving.canCancel) {
      void fetch(`${base}/attempts/${encodeURIComponent(leaving.attemptId)}/cancel`, {
        method: "POST", headers, keepalive: true,
        body: JSON.stringify({ expectedRevision: leaving.revision }),
      }).catch(() => undefined);
    }
  });
  useEffect(() => {
    alive.current = true;
    current.current = null; sdk.current = null; challenge.current = null; preparedSdk.current = null;
    inFlight.current = false; popupOpen.current = false;
    startKey.current = crypto.randomUUID();
    if (targetConnectionId) heading.current?.focus({ preventScroll: true });
    const controller = new AbortController();
    void loadSession(controller);
    return () => { controller.abort(); leaveSession(); };
  }, [csrf, targetConnectionId, transitionId, legacyMigrationId, purpose]);

  useVisibleRefresh(refresh, !scopeMismatch && !loading && !pending && !waitingForMeta && Boolean(attempt || uncertain),
    uncertain || attempt?.status === "EXCHANGING" || attempt?.status === "PROVISIONING" ? 3_000 : 30_000);

  async function mutate(path: string, body: unknown, onResult?: (result: MetaSignupStartResponse) => void) {
    if (inFlight.current || scopeMismatch) return;
    inFlight.current = true;
    setPending(true); busyChanged(true); setError(null);
    const version = generation.current;
    try {
      const result = await request<MetaSignupStartResponse>(path, body);
      if (!alive.current || version !== generation.current) return;
      accept(result, path.startsWith("attempts/") ? path.split("/")[1] : undefined); setUncertain(false); onResult?.(result);
    } catch (failure) {
      if (!alive.current || version !== generation.current) return;
      setError(localizedUiError(locale, failure).message);
      // Read durable status after a lost response. Never retry an exchange or
      // registration automatically, even when the browser did not see success.
      setUncertain(true);
    } finally {
      if (alive.current && version === generation.current) {
        inFlight.current = false; setPending(false); busyChanged(false);
      }
    }
  }

  function prepare() {
    if (scopeMismatch || (legacy && readback) || inFlight.current || target?.canPrepare === false || !capability?.enabled || !sdkReady || !name.trim() || name.trim().length > 100 || /\p{Cc}/u.test(name) || (attempt && !attempt.canStartAgain)) return;
    if (selectedVariant && (!capability.businessAppEnabled || !echoesConsent)) return;
    if (attempt?.canStartAgain) startKey.current = crypto.randomUUID();
    invalidateCallback(); challenge.current = null; preparedSdk.current = null; setAuthorizationPrepared(false); setWaitingForMeta(false);
    void mutate("attempts", { name: name.trim(), payerMode: "CUSTOMER", idempotencyKey: startKey.current,
      ...(targetConnectionId ? { targetConnectionId, ...(transitionId ? { targetTransitionId: transitionId } : legacyMigrationId ? { targetLegacyMigrationId: legacyMigrationId } : {}) } : addingAccess ? { purpose: "ADD_ACCESS" } : {}),
      ...(selectedVariant ? { variant: "BUSINESS_APP", coexistenceConsent: { version: "2026-10-07", history: historyConsent, contacts: contactsConsent, echoes: true } } : {}) }, result => {
      challenge.current = result.challenge ?? null;
      setAuthorizationPrepared(Boolean(result.challenge));
      preparedSdk.current = result.sdk;
      // Each variant receives its own server-approved configuration before launch.
      if (!capability.sdk || result.sdk.appId !== capability.sdk.appId || result.sdk.graphVersion !== capability.sdk.graphVersion
        || (selectedVariant ? result.variant !== "BUSINESS_APP" || result.sdk.variant !== "BUSINESS_APP"
          || !/^\d{5,32}$/u.test(result.sdk.configId) || result.sdk.extras?.featureType !== "whatsapp_business_app_onboarding"
          || result.sdk.extras?.sessionInfoVersion !== "3" || !result.sdk.extras?.setup || Object.keys(result.sdk.extras.setup).length !== 0
          : (result.variant ?? "STANDARD") !== "STANDARD" || (result.sdk.variant ?? "STANDARD") !== "STANDARD" || result.sdk.configId !== capability.sdk.configId)) {
        challenge.current = null; setAuthorizationPrepared(false); setError(t("tenant.metaSignup.configurationChanged"));
      }
    });
  }

  function connect() {
    const view = current.current;
    const nonce = challenge.current;
    const configuration = preparedSdk.current;
    if (scopeMismatch || !targetCanContinue.current || inFlight.current || popupOpen.current || !view || view.status !== "AWAITING_AUTHORIZATION" || !nonce || !sdk.current || !configuration) return;
    if (Date.parse(view.expiresAt) <= Date.now()) { challenge.current = null; setAuthorizationPrepared(false); setError(t("tenant.metaSignup.expired")); return; }
    const version = ++generation.current;
    popupOpen.current = true;
    setWaitingForMeta(true); setError(null);
    try {
      disposePopupDiagnostics.current = launchMetaSignup(sdk.current, configuration,
        () => alive.current && targetCanContinue.current && generation.current === version && current.current?.attemptId === view.attemptId,
        code => {
          challenge.current = null;
          setAuthorizationPrepared(false);
          popupOpen.current = false;
          setWaitingForMeta(false);
          if (!code) { setError(t("tenant.metaSignup.popupIncomplete")); return; }
          // No discovery or optional request may precede this short-lived code exchange.
          void mutate(`attempts/${encodeURIComponent(view.attemptId)}/exchange`, { expectedRevision: view.revision, challenge: nonce, code });
        }, value => {
          // Advisory logging cannot delay or replace the callback-code exchange.
          const canonical = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: value.event, version: 3, sourceOrigin: value.sourceOrigin });
          void crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)).then(digest => {
            if (!alive.current || !popupOpen.current || generation.current !== version || current.current?.attemptId !== view.attemptId) return;
            const traceSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            return request(`attempts/${encodeURIComponent(view.attemptId)}/session-log`, { challenge: nonce, ...value, traceSha256 });
          }).catch(() => undefined);
        });
    } catch {
      challenge.current = null; setAuthorizationPrepared(false); popupOpen.current = false; setWaitingForMeta(false); setError(t("tenant.metaSignup.popupIncomplete"));
    }
  }

  function cancel() {
    const view = current.current;
    if (scopeMismatch || !view?.canCancel || inFlight.current) return;
    invalidateCallback(); challenge.current = null; setAuthorizationPrepared(false); popupOpen.current = false; setWaitingForMeta(false);
    void mutate(`attempts/${encodeURIComponent(view.attemptId)}/cancel`, { expectedRevision: view.revision }, () => { startKey.current = crypto.randomUUID(); });
  }

  function select() {
    if (!targetCanContinue.current || !attempt || !selected || attempt.selectionRevision === undefined || !pinValid) return;
    const registrationPin = needsPin && pin ? pin : undefined;
    setPin("");
    void mutate(`attempts/${encodeURIComponent(attempt.attemptId)}/select`, {
      expectedRevision: attempt.revision, selectionRevision: attempt.selectionRevision, choiceId: selected.choiceId,
      ...(registrationPin ? { registrationPin } : {}),
    });
  }

  const renewed = reconnect && attempt?.status === "COMPLETED" && attempt.outcome === (legacy ? "MIGRATION_ACCESS_VERIFIED" : readback ? "READBACK_ACCESS_RENEWED" : "ACCESS_RENEWED_PAUSED")
    && attempt.connectionId === targetConnectionId;
  const added = addingAccess && attempt?.status === "COMPLETED" && attempt.outcome === "ACCESS_ADDED_PAUSED" && Boolean(attempt.connectionId);
  const statusKey = addingAccess && attempt && ["SELECTION_REQUIRED", "PROVISIONING", "COMPLETED"].includes(attempt.status)
    ? `tenant.metaSignup.addAccess.status.${attempt.status === "COMPLETED" && !added ? "UNCONFIRMED" : attempt.status}`
    : legacy && attempt && ["SELECTION_REQUIRED", "PROVISIONING", "COMPLETED"].includes(attempt.status)
    ? `tenant.metaSignup.legacy.status.${attempt.status === "COMPLETED" && !renewed ? "UNCONFIRMED" : attempt.status}`
    : readback && attempt && ["SELECTION_REQUIRED", "PROVISIONING", "COMPLETED"].includes(attempt.status)
    ? `tenant.metaSignup.readback.status.${attempt.status === "COMPLETED" && !renewed ? "UNCONFIRMED" : attempt.status}`
    : reconnect && attempt && ["SELECTION_REQUIRED", "PROVISIONING", "COMPLETED"].includes(attempt.status)
    ? `tenant.metaSignup.reconnect.status.${attempt.status === "COMPLETED" && !renewed ? "UNCONFIRMED" : attempt.status}`
    : `tenant.metaSignup.status.${attempt?.status}`;
  const canDiscover = !scopeMismatch && target?.canContinue !== false && attempt && !attempt.connectionId && (["SELECTION_REQUIRED", "NUMBER_REQUIRED", "ACTION_REQUIRED"].includes(attempt.status)
    || (attempt.status === "OUTCOME_UNKNOWN" && attempt.reasonCode === "META_SIGNUP_CREDENTIAL_UNAVAILABLE"));
  return <section className={styles.setup} aria-labelledby="meta-signup-heading" aria-busy={pending || loading}>
    <h3 id="meta-signup-heading" ref={heading} tabIndex={-1}>{t(legacy ? "tenant.metaSignup.legacy.title" : readback ? "tenant.metaSignup.readback.title" : reconnect ? "tenant.metaSignup.reconnect.title" : addingAccess ? "tenant.metaSignup.addAccess.title" : "tenant.metaSignup.title")}</h3>
    {target ? <p>{t("tenant.metaSignup.reconnect.target")} <strong><bdi>{attempt?.target?.name ?? target.name}</bdi></strong></p> : null}
    <p>{t(legacy ? "tenant.metaSignup.legacy.body" : readback ? "tenant.metaSignup.readback.body" : reconnect ? "tenant.metaSignup.reconnect.body" : addingAccess ? "tenant.metaSignup.addAccess.body" : "tenant.metaSignup.ownership")}</p>
    <p>{t(legacy ? "tenant.metaSignup.legacy.billing" : readback ? "tenant.metaSignup.readback.billing" : reconnect ? "tenant.metaSignup.reconnect.billing" : addingAccess ? "tenant.metaSignup.addAccess.billing" : "tenant.metaSignup.billing")}</p>
    {!reconnect && !addingAccess && capability?.businessAppEnabled && (!attempt || attempt.canStartAgain) ? <fieldset className={styles.choices} disabled={pending || waitingForMeta || uncertain}>
      <legend>{t("tenant.metaCoexistence.signup.variant")}</legend>
      {(["STANDARD", "BUSINESS_APP"] as const).map(option => <label className={styles.choice} key={option}>
        <input type="radio" name="meta-signup-variant" checked={variant === option} onChange={() => { startKey.current = crypto.randomUUID(); setVariant(option); }} />
        <span>{t(`tenant.metaCoexistence.signup.${option}`)}</span>
      </label>)}
    </fieldset> : null}
    {selectedVariant ? <div>
      <p>{t("tenant.metaCoexistence.signup.eligibility")}</p>
      <p>{t("tenant.metaCoexistence.signup.devices")}</p>
      <p>{t("tenant.metaCoexistence.signup.oneShot")}</p>
      {attempt && !attempt.canStartAgain ? <dl className={styles.readiness}>
        {(["history", "contacts", "echoes"] as const).map(key => <div key={key}><dt>{t(`tenant.metaCoexistence.signup.${key}`)}</dt>
          <dd>{t(attempt.coexistenceConsent?.[key] ? "tenant.metaCoexistence.signup.allowed" : "tenant.metaCoexistence.signup.notAllowed")}</dd></div>)}
      </dl> : <fieldset className={styles.choices} disabled={pending || uncertain}>
        <legend>{t("tenant.metaCoexistence.signup.consent")}</legend>
        <label className={styles.choice}><input type="checkbox" checked={historyConsent} onChange={event => { startKey.current = crypto.randomUUID(); setHistoryConsent(event.target.checked); }} /><span>{t("tenant.metaCoexistence.signup.history")}</span></label>
        <label className={styles.choice}><input type="checkbox" checked={contactsConsent} onChange={event => { startKey.current = crypto.randomUUID(); setContactsConsent(event.target.checked); }} /><span>{t("tenant.metaCoexistence.signup.contacts")}</span></label>
        <label className={styles.choice}><input type="checkbox" checked={echoesConsent} onChange={event => { startKey.current = crypto.randomUUID(); setEchoesConsent(event.target.checked); }} /><span>{t("tenant.metaCoexistence.signup.echoes")}</span></label>
      </fieldset>}
    </div> : null}
    {target?.canContinue === false ? <p role="status">{t(legacy ? "tenant.metaSignup.legacy.held" : readback ? "tenant.metaSignup.readback.held" : "tenant.metaSignup.reason.META_SIGNUP_RECONNECT_PAUSE_REQUIRED")}</p> : null}
    {target?.canPrepare === false && !attempt ? <p role="status">{t("tenant.metaSignup.reconnect.waiting")}</p> : null}
    {loading ? <p role="status">{t("tenant.metaSignup.loading")}</p> : null}
    {!loading && capability && !capability.enabled ? <p role="status">{t(reconnect ? "tenant.metaSignup.reconnect.unavailable" : "tenant.metaSignup.unavailable")}</p> : null}
    {scopeMismatch ? <p className={styles.error} role="alert">{t("tenant.metaSignup.scopeChanged")}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {uncertain ? <p role="status">{t("tenant.metaSignup.checking")}</p> : null}
    {attempt && !scopeMismatch ? <>
      <p role="status" aria-live="polite">{t(statusKey)}</p>
      {attempt.reasonCode ? <p>{t(`tenant.metaSignup.reason.${attempt.reasonCode}`)}</p> : null}
      {attempt.status === "AWAITING_AUTHORIZATION" && !authorizationPrepared && !pending && !waitingForMeta
        ? <p>{t("tenant.metaSignup.resumeAuthorization")}</p> : null}
      {waitingForMeta ? <p role="status">{t("tenant.metaSignup.waiting")}</p> : null}
      {attempt.choices.length ? <fieldset className={styles.choices} disabled={pending || target?.canContinue === false || attempt.nextAction !== "SELECT_NUMBER"}>
        <legend>{t(legacy ? "tenant.metaSignup.legacy.choose" : readback ? "tenant.metaSignup.readback.choose" : reconnect ? "tenant.metaSignup.reconnect.choose" : addingAccess ? "tenant.metaSignup.addAccess.choose" : "tenant.metaSignup.choose")}</legend>
        {attempt.choices.map(choice => <label key={choice.choiceId} className={styles.choice}>
          <input type="radio" name="meta-signup-number" value={choice.choiceId} checked={choiceId === choice.choiceId}
            disabled={!selectable(choice)} onChange={() => { setChoiceId(choice.choiceId); setPin(""); }} />
          <span><strong><bdi>{choice.displayPhoneNumber}</bdi></strong><span><bdi>{choice.accountName}</bdi></span>
            {choice.verifiedName && choice.verifiedName !== choice.accountName ? <small><bdi>{choice.verifiedName}</bdi></small> : null}
            <small><bdi>{choice.businessName}</bdi></small>
            {choice.reasonCode ? <small>{t(`tenant.metaSignup.reason.${choice.reasonCode}`)}</small> : null}</span>
        </label>)}
      </fieldset> : null}
      {addingAccess ? attempt.choices.filter(choice => choice.existingConnection).map(choice => <div key={choice.choiceId} className={styles.actions}>
        <button type="button" className="button secondary" disabled={pending} onClick={() => created(choice.existingConnection!.connectionId)}>
          {t("tenant.metaSignup.addAccess.reviewExisting", { name: `\u2068${choice.existingConnection!.name}\u2069` })}
        </button>
      </div>) : null}
      {needsPin ? <div><label htmlFor="meta-signup-registration-pin">{t("tenant.metaSignup.pin")}
        <input id="meta-signup-registration-pin" type="password" inputMode="numeric" autoComplete="new-password" dir="ltr"
          maxLength={6} value={pin} disabled={pending} onChange={event => setPin(event.target.value)} aria-describedby="meta-signup-pin-help" />
      </label>
        <small id="meta-signup-pin-help">{t(resumingSelection ? "tenant.metaSignup.pinResumeHelp" : "tenant.metaSignup.pinHelp")}</small>
      </div> : null}
      {attempt.status !== "AWAITING_AUTHORIZATION" ? <dl className={styles.readiness}>
        {(["authorization", "number", "subscription", "messaging"] as const).map(key => <div key={key}>
          <dt>{t(`tenant.metaSignup.readiness.${key}`)}</dt><dd>{t(`tenant.metaSignup.value.${attempt.readiness[key]}`)}</dd>
        </div>)}
        <div><dt>{t("tenant.metaSignup.readiness.payment")}</dt><dd>{t(`tenant.metaSignup.value.${attempt.readiness.payment.status}`)}</dd></div>
      </dl> : null}
      {attempt.connectionId && !reconnect ? <p>{t(addingAccess ? "tenant.metaSignup.addAccess.next" : "tenant.metaSignup.workflow")}</p> : null}
    </> : null}
    <div className={styles.actions}>
      {!scopeMismatch && !loading && capability?.enabled && (!attempt || attempt.canStartAgain) ? <button type="button" className="button primary"
        disabled={pending || !sdkReady || uncertain || target?.canPrepare === false || (selectedVariant && !echoesConsent)} onClick={prepare}>{t(pending ? "tenant.metaSignup.preparing" : legacy ? "tenant.metaSignup.legacy.prepare" : readback ? "tenant.metaSignup.readback.prepare" : reconnect ? "tenant.metaSignup.reconnect.prepare" : addingAccess ? "tenant.metaSignup.addAccess.prepare" : "tenant.metaSignup.prepare")}</button> : null}
      {!scopeMismatch && attempt?.status === "AWAITING_AUTHORIZATION" && authorizationPrepared ? <button type="button" className="button primary"
        disabled={pending || waitingForMeta || !sdkReady || uncertain || target?.canContinue === false} onClick={connect}>{t("tenant.metaSignup.connect")}</button> : null}
      {selected ? <button type="button" className="button primary" disabled={pending || uncertain || !pinValid || target?.canContinue === false}
        onClick={select}>{t(legacy ? "tenant.metaSignup.legacy.select" : readback ? "tenant.metaSignup.readback.select" : reconnect ? "tenant.metaSignup.reconnect.select" : addingAccess ? "tenant.metaSignup.addAccess.select" : resumingSelection ? "tenant.metaSignup.resumeSelect" : "tenant.metaSignup.select")}</button> : null}
      {!scopeMismatch && attempt?.connectionId && ((!reconnect && !addingAccess) || renewed || added || (addingAccess && attempt.status !== "COMPLETED")) ? <button type="button" className="button primary" disabled={pending} onClick={() => created(attempt.connectionId!)}>{t(legacy ? "tenant.metaSignup.legacy.back" : readback ? "tenant.metaSignup.readback.back" : "tenant.metaSignup.view")}</button> : null}
      {canDiscover ? <button type="button" className="button secondary" disabled={pending || uncertain}
        onClick={() => void mutate(`attempts/${encodeURIComponent(attempt.attemptId)}/discover`, { expectedRevision: attempt.revision })}>{t("tenant.metaSignup.discover")}</button> : null}
      {!scopeMismatch && attempt?.canCancel ? <button type="button" className="button secondary" disabled={pending} onClick={cancel}>{t("tenant.metaSignup.cancel")}</button> : null}
      {!scopeMismatch && (uncertain || attempt?.status === "OUTCOME_UNKNOWN" || ((reconnect || addingAccess) && attempt?.status === "COMPLETED" && !(renewed || added))) ? <button type="button" className="button secondary" disabled={pending} onClick={() => void refresh().catch(failure => setError(localizedUiError(locale, failure).message))}>{t("tenant.metaSignup.refresh")}</button> : null}
    </div>
    <div className={styles.actions}>
      {!((renewed || added) && attempt?.connectionId && !scopeMismatch) ? <button type="button" className="button secondary" disabled={pending} onClick={back}>{t(legacy ? "tenant.metaSignup.legacy.back" : readback ? "tenant.metaSignup.readback.back" : reconnect ? "tenant.metaSignup.reconnect.back" : "tenant.setup.actions.back")}</button> : null}
      {!reconnect && manual ? <button type="button" className="text-button" disabled={pending || Boolean(attempt && !["AWAITING_AUTHORIZATION", "CANCELLED", "EXPIRED", "FAILED"].includes(attempt.status))}
        onClick={manual}>{t("tenant.metaSignup.manual")}</button> : null}
    </div>
  </section>;
}
