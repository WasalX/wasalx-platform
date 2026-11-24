"use client";
import { createReplaceableRequestController } from "../lib/meta-capability-request";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MetaGroupsCapability } from "../lib/control-plane-data";
import { ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { formatDateTime, formatNumber } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { connectionAuthorizationState, connectionInboundIsReady, connectionTransportIsReady } from "../lib/connection-readiness.ts";
import { type ConnectionDetailRow, isDuplicateIdentityRejection, RelativeTime, exactTime, type TenantTranslator, connectionMethod, apiError, requiresPrivilegedReauthentication, privilegedStepUpHref, Status, Empty, SectionLoading, useDialogCloseGuard, DirtyCloseConfirmation } from "./tenant-ui";

const MetaSignup = lazy(async () => ({ default: (await import("./MetaSignup")).MetaSignup }));
const MetaNumberRelease = lazy(async () => ({ default: (await import("./MetaNumberRelease")).MetaNumberRelease }));
const MetaTemplatePreparation = lazy(async () => ({ default: (await import("./MetaTemplatePreparation")).MetaTemplatePreparation }));
const MetaLegacyMigration = lazy(async () => ({ default: (await import("./MetaLegacyMigration")).MetaLegacyMigration }));
const MetaCoexistence = lazy(async () => ({ default: (await import("./MetaCoexistence")).MetaCoexistence }));
const MetaBillingDiagnostics = lazy(async () => ({ default: (await import("./MetaBillingDiagnostics")).MetaBillingDiagnostics }));
const MetaCustomerPaymentPolicy = lazy(async () => ({ default: (await import("./MetaCustomerPaymentPolicy")).MetaCustomerPaymentPolicy }));
const MetaRoutingConfiguration = lazy(async () => ({ default: (await import("./MetaRouting")).MetaRoutingConfiguration }));
const MetaSavedAccessActivation = lazy(async () => ({ default: (await import("./MetaSavedAccessActivation")).MetaSavedAccessActivation }));

type LifecycleAction = "start" | "restart" | "pause" | "disconnect" | "sync";

type PasskeyAssertionPayload = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
};

type PasskeyChallengePayload = {
  challenge: string;
  timeout?: number;
  rpId: "web.whatsapp.com";
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: Array<"ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">;
  }>;
  userVerification?: "discouraged" | "preferred" | "required";
};

type AuthorizationRetry =
  | { kind: "qr" }
  | { kind: "pairing"; key: string; phoneNumber: string }
  | { kind: "passkey"; key: string; assertion: PasskeyAssertionPayload }
  | { kind: "confirm"; key: string };

type QrAuthorization = {
  imageDataUrl: string | null;
  providerState: string;
  issuedAt: string | null;
  expiresAt: string | null;
  sequence: number;
  expired: boolean;
};

const CONNECTION_STATE_GUIDANCE: Record<string, { titleKey: string; bodyKey: string }> = {
  PROVISIONING: {
    titleKey: "tenant.connection.guidance.provisioning.title",
    bodyKey: "tenant.connection.guidance.provisioning.body",
  },
  AWAITING_AUTH: {
    titleKey: "tenant.connection.guidance.awaitingAuthorization.title",
    bodyKey: "tenant.connection.guidance.awaitingAuthorization.body",
  },
  CONNECTING: {
    titleKey: "tenant.connection.guidance.connecting.title",
    bodyKey: "tenant.connection.guidance.connecting.body",
  },
  VERIFYING: {
    titleKey: "tenant.connection.guidance.verifying.title",
    bodyKey: "tenant.connection.guidance.verifying.body",
  },
  AWAITING_INBOUND: {
    titleKey: "tenant.connection.guidance.awaitingInbound.title",
    bodyKey: "tenant.connection.guidance.awaitingInbound.body",
  },
  META_ROUTING_REQUIRED: {
    titleKey: "tenant.connection.guidance.metaRoutingRequired.title",
    bodyKey: "tenant.connection.guidance.metaRoutingRequired.body",
  },
  META_ROUTING_HELD: {
    titleKey: "tenant.connection.guidance.metaRoutingHeld.title",
    bodyKey: "tenant.connection.guidance.metaRoutingHeld.body",
  },
  WORKING: {
    titleKey: "tenant.connection.guidance.working.title",
    bodyKey: "tenant.connection.guidance.working.body",
  },
  DEGRADED: {
    titleKey: "tenant.connection.guidance.degraded.title",
    bodyKey: "tenant.connection.guidance.degraded.body",
  },
  ACTION_REQUIRED: {
    titleKey: "tenant.connection.guidance.actionRequired.title",
    bodyKey: "tenant.connection.guidance.actionRequired.body",
  },
  FAILED: {
    titleKey: "tenant.connection.guidance.failed.title",
    bodyKey: "tenant.connection.guidance.failed.body",
  },
  PAUSED: {
    titleKey: "tenant.connection.guidance.paused.title",
    bodyKey: "tenant.connection.guidance.paused.body",
  },
  REVOKED: {
    titleKey: "tenant.connection.guidance.revoked.title",
    bodyKey: "tenant.connection.guidance.revoked.body",
  },
};

function exactTimeWithSeconds(value: unknown, locale: "en" | "ar", fallback: string) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? fallback
    : formatDateTime(date, locale, { dateStyle: "medium", timeStyle: "medium" });
}

const CONNECTION_LIFECYCLE_STATES = new Set([
  "provisioning",
  "awaiting_auth",
  "connecting",
  "working",
  "degraded",
  "action_required",
  "failed",
  "paused",
  "revoked",
  "queued",
  "running",
  "failed_retryable",
]);

function connectionStateText(value: unknown, t: TenantTranslator) {
  const state = String(value ?? "").toLowerCase();
  return t(CONNECTION_LIFECYCLE_STATES.has(state)
    ? `tenant.connection.lifecycle.state.${state}`
    : "tenant.status.unknown");
}

function authorizationState(value: unknown, t: TenantTranslator) {
  const state = String(value ?? "").toUpperCase();
  if (state === "LAST_VERIFIED") return t("tenant.connection.health.lastVerificationPassed");
  if (state === "PAUSED") return t("tenant.status.paused");
  if (state === "ACTION_REQUIRED") return t("tenant.status.actionRequired");
  if (state === "WORKING") return t("common.status.connected");
  if (["STARTING", "CONNECTING"].includes(state)) return t("tenant.status.connecting");
  if (["SCAN_QR_CODE", "PAIRING_CODE_REQUIRED", "PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"].includes(state)) return t("tenant.status.actionRequired");
  if (["FAILED", "STOPPED", "REVOKED"].includes(state)) return t("tenant.status.needsAttention");
  return t("tenant.connection.notReported");
}

function qrCountdown(milliseconds: number, locale: "en" | "ar") {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${formatNumber(Math.floor(seconds / 60), locale, { useGrouping: false })}:${formatNumber(seconds % 60, locale, { minimumIntegerDigits: 2, useGrouping: false })}`;
}

const WAHA_PASSKEY_CHROME_EXTENSION_ID = "ghpdcgnjffaaekflfpcgkgpbafmjldcp";
const PASSKEY_CLIENT_ERROR = {
  unavailable: "PASSKEY_EXTENSION_UNAVAILABLE",
  noResponse: "PASSKEY_EXTENSION_NO_RESPONSE",
  rejected: "PASSKEY_EXTENSION_REJECTED",
  invalidAssertion: "PASSKEY_ASSERTION_INVALID",
} as const;

function passkeyClientErrorMessage(error: unknown, t: TenantTranslator) {
  const code = error instanceof Error ? error.message : "";
  if (code === PASSKEY_CLIENT_ERROR.unavailable) return t("tenant.connection.errors.passkeyExtensionUnavailable");
  if (code === PASSKEY_CLIENT_ERROR.noResponse) return t("tenant.connection.errors.passkeyExtensionNoResponse");
  if (code === PASSKEY_CLIENT_ERROR.invalidAssertion) return t("tenant.connection.errors.assertionInvalid");
  return t("tenant.connection.errors.passkeyStep");
}

async function signPasskeyWithOfficialExtension(
  challenge: PasskeyChallengePayload,
): Promise<PasskeyAssertionPayload> {
  if (/firefox/i.test(navigator.userAgent)) {
    return passkeyAssertionFromUnknown(await callFirefoxPasskeyExtension(challenge));
  }
  const runtime = (window as typeof window & {
    chrome?: {
      runtime?: {
        lastError?: { message?: string };
        sendMessage(
          extensionId: string,
          message: unknown,
          callback: (response: unknown) => void,
        ): void;
      };
    };
  }).chrome?.runtime;
  if (!runtime?.sendMessage) {
    throw new Error(PASSKEY_CLIENT_ERROR.unavailable);
  }
  const response = await new Promise<unknown>((resolve, reject) => {
    runtime.sendMessage(
      WAHA_PASSKEY_CHROME_EXTENSION_ID,
      { type: "waha-passkey-sign", challenge },
      (value) => {
        if (runtime.lastError) {
          reject(new Error(PASSKEY_CLIENT_ERROR.noResponse));
          return;
        }
        resolve(value);
      },
    );
  });
  const record = response && typeof response === "object" ? response as Record<string, unknown> : null;
  if (record?.ok !== true) {
    throw new Error(PASSKEY_CLIENT_ERROR.rejected);
  }
  return passkeyAssertionFromUnknown(record.assertion);
}

function callFirefoxPasskeyExtension(challenge: PasskeyChallengePayload) {
  return new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(PASSKEY_CLIENT_ERROR.noResponse));
    }, 120_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | null;
      if (
        !data ||
        data.source !== "waha-passkey-extension" ||
        data.requestId !== requestId
      ) return;
      cleanup();
      if (data.ok !== true) {
        reject(new Error(PASSKEY_CLIENT_ERROR.rejected));
        return;
      }
      resolve(data.assertion);
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: "waha-passkey-page",
        requestId,
        type: "waha-passkey-sign",
        challenge,
      },
      window.location.origin,
    );
  });
}

function passkeyAssertionFromUnknown(value: unknown): PasskeyAssertionPayload {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const response = record?.response && typeof record.response === "object" && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : null;
  const base64 = (candidate: unknown) =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= 65_536 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)
      ? candidate
      : null;
  const id = base64(record?.id);
  const rawId = base64(record?.rawId);
  const clientDataJSON = base64(response?.clientDataJSON);
  const authenticatorData = base64(response?.authenticatorData);
  const signature = base64(response?.signature);
  const userHandle = response?.userHandle === null ? null : base64(response?.userHandle);
  if (!id || !rawId || record?.type !== "public-key" || !clientDataJSON || !authenticatorData || !signature) {
    throw new Error(PASSKEY_CLIENT_ERROR.invalidAssertion);
  }
  return {
    id,
    rawId,
    type: "public-key",
    response: { clientDataJSON, authenticatorData, signature, userHandle },
  };
}

export function ConnectionDetail({
  id,
  tenantId,
  actorId,
  canConfigure,
  canReadSettings,
  canWriteSettings,
  mutationHeaders,
  updated,
  close,
}: {
  id: string;
  tenantId: string;
  actorId: string;
  canConfigure: boolean;
  canReadSettings: boolean;
  canWriteSettings: boolean;
  mutationHeaders: Record<string, string>;
  updated: (detail: ConnectionDetailRow) => void;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<ConnectionDetailRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectTrigger = useRef<HTMLButtonElement>(null);
  const disconnectInput = useRef<HTMLInputElement>(null);
  const restoreDisconnectFocus = useRef(false);
  useEffect(() => {
    if (disconnecting) disconnectInput.current?.focus();
    else if (restoreDisconnectFocus.current) {
      restoreDisconnectFocus.current = false;
      disconnectTrigger.current?.focus();
    }
  }, [disconnecting]);
  const [confirmation, setConfirmation] = useState("");
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizationNotice, setAuthorizationNotice] = useState<string | { kind: "qr" } | null>(null);
  const [qr, setQr] = useState<QrAuthorization | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const autoLoadedQrReadyAt = useRef<string | null>(null);
  const autoLoadingQrReadyAt = useRef<string | null>(null);
  const autoQrRetryTimer = useRef<number | null>(null);
  const autoQrActive = useRef(true);
  const refreshGeneration = useRef(0);
  const [qrClock, setQrClock] = useState(() => Date.now());
  const [qrPollAttempt, setQrPollAttempt] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [passkeyConfirmationCode, setPasskeyConfirmationCode] = useState<string | null>(null);
  const [passkeyChallenge, setPasskeyChallenge] = useState<PasskeyChallengePayload | null>(null);
  const [manualAssertion, setManualAssertion] = useState("");
  const [advancedPasskeyOpen, setAdvancedPasskeyOpen] = useState(false);
  const [authorizationRetry, setAuthorizationRetry] = useState<AuthorizationRetry | null>(null);
  const [metaCredentialRevision, setMetaCredentialRevision] = useState(0);
  const [metaReconnectOpen, setMetaReconnectOpen] = useState(false);
  const metaReconnectTargetRevoked = useRef(false);
  const [metaReconnectPending, setMetaReconnectPending] = useState(false);
  const [metaNumberReleasePending, setMetaNumberReleasePending] = useState(false);
  const metaReconnectTrigger = useRef<HTMLButtonElement>(null);
  const restoreMetaReconnectFocus = useRef(false);
  useEffect(() => {
    if (!metaReconnectOpen && restoreMetaReconnectFocus.current) {
      restoreMetaReconnectFocus.current = false; metaReconnectTrigger.current?.focus();
    }
  }, [metaReconnectOpen]);
  const [metaGroupsAccepted, setMetaGroupsAccepted] = useState(false);
  const [dirtyDrafts, setDirtyDrafts] = useState<ReadonlySet<"authorization" | "credential" | "reconnect" | "group" | "safety" | "disconnect">>(() => new Set());
  const [retryIntent, setRetryIntent] = useState<{
    action: LifecycleAction;
    key: string;
    body: Record<string, unknown>;
  } | null>(null);
  const setDraftDirty = useCallback((source: "authorization" | "credential" | "reconnect" | "group" | "safety" | "disconnect", dirty: boolean) => {
    setDirtyDrafts((current) => {
      const next = new Set(current);
      if (dirty) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  const setSafetyDraftDirty = useCallback((dirty:boolean) => setDraftDirty("safety",dirty),[setDraftDirty]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current;
    try {
      const response = await fetch(`/api/connections/${encodeURIComponent(id)}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        if (generation !== refreshGeneration.current) return;
        if (response.status === 401) {
          const message = await apiError(response);
          setSessionExpired(true);
          setQr(null);
          setQrExpanded(false);
          setAuthorizationError(message);
          setLoadError(message);
          return;
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const nextDetail = (await response.json()) as ConnectionDetailRow;
      if (generation !== refreshGeneration.current) return;
      metaReconnectTargetRevoked.current = nextDetail.provider === "META" && String(nextDetail.state).toUpperCase() === "REVOKED";
      if (metaReconnectTargetRevoked.current) {
        setMetaReconnectOpen(false);
        setDraftDirty("reconnect", false);
        restoreMetaReconnectFocus.current = false;
      }
      setDetail(nextDetail);
      updated(nextDetail);
      setLoadError(null);
      setSessionExpired(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (generation !== refreshGeneration.current) return;
      setLoadError(
        operatorFailureMessage(error, t("tenant.connection.errors.load")),
      );
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [id, t, updated, setDraftDirty]);

  const reload = useCallback(async () => {
    setLoading(true);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    autoQrActive.current = true;
    autoLoadedQrReadyAt.current = null;
    autoLoadingQrReadyAt.current = null;
    if (autoQrRetryTimer.current !== null) window.clearTimeout(autoQrRetryTimer.current);
    autoQrRetryTimer.current = null;
    return () => {
      autoQrActive.current = false;
      if (autoQrRetryTimer.current !== null) window.clearTimeout(autoQrRetryTimer.current);
    };
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
    };
  }, [refresh]);
  const runAction = async (
    action: LifecycleAction,
    existingIntent?: typeof retryIntent,
  ) => {
    const intent = existingIntent ?? {
      action,
      key: crypto.randomUUID(),
      body: action === "disconnect" ? { confirmation: "DISCONNECT" }
        : action === "sync" && detail?.provider === "META" && !detail.disclosure_version && metaGroupsAccepted
          ? { eligibilityAccepted: true, eligibilityVersion: "2026-08-09" } : {},
    };
    if (!intent) return;
    setRetryIntent(intent);
    setActionPending(true);
    setActionError(null);
    setNotice(null);
    const path = intent.action === "sync" ? "groups/sync" : intent.action;
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/${path}`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders,
            "idempotency-key": intent.key,
          },
          body: JSON.stringify(intent.body),
        },
      );
      if (!response.ok) {
        const rejection: unknown = await response.clone().json().catch(() => null);
        if (rejection && typeof rejection === "object" && "code" in rejection && rejection.code === "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED") {
          setRetryIntent(null);
          throw operatorLocalFailure(t("tenant.metaSignup.reason.META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED"));
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const accepted = (await response.json()) as {
        operation?: { type?: string; state?: string };
        duplicate?: boolean;
      };
      setNotice(t(
        accepted.duplicate
          ? "tenant.connection.lifecycle.alreadyAccepted"
          : "tenant.connection.lifecycle.accepted",
        { action: t(`tenant.connection.lifecycle.action.${intent.action}`) },
      ));
      setRetryIntent(null);
      if (intent.body.eligibilityAccepted === true) {
        setMetaGroupsAccepted(false);
        setDraftDirty("group", false);
      }
      if (intent.action === "disconnect") {
        setDisconnecting(false);
        setConfirmation("");
        setDraftDirty("disconnect", false);
      }
      await refresh();
    } catch (error) {
      setActionError(
        operatorFailureMessage(error, t("tenant.connection.errors.lifecycle")),
      );
    } finally {
      setActionPending(false);
    }
  };

  const loadQr = useCallback(async (silent = false) => {
    if (!silent) setAuthorizationPending(true);
    // A background freshness poll must not erase a visible failure before it
    // has produced a newer successful provider observation.
    if (!silent) {
      setAuthorizationError(null);
      setAuthorizationNotice(null);
    }
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/qr`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        if (response.status === 401) {
          setSessionExpired(true);
          setQr(null);
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const result = (await response.json()) as QrAuthorization;
      setQr(result);
      setQrClock(Date.now());
      setSessionExpired(false);
      setAuthorizationError(null);
      setAuthorizationRetry(null);
      if (!silent) {
        setAuthorizationNotice({ kind: "qr" });
      }
      return true;
    } catch (error) {
      if (silent) {
        // Re-arm the expiry poll after a transient provider/network failure.
        // Without this tick, the one-shot timer would never run again because
        // the last provider QR object intentionally remains unchanged.
        setQrPollAttempt((attempt) => attempt + 1);
      } else {
        const message = operatorFailureMessage(error, t("tenant.connection.errors.qrLoad"));
        const expiresAt = qr?.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
        const validQrPreserved = Boolean(
          !sessionExpired && qr?.imageDataUrl && !qr.expired && expiresAt > Date.now(),
        );
        setAuthorizationRetry({ kind: "qr" });
        setAuthorizationError(
          validQrPreserved
            ? t("tenant.connection.authorization.qr.lastValidPreserved", { message, expiresAt: exactTimeWithSeconds(qr?.expiresAt, locale, t("tenant.time.invalid")) })
            : message,
        );
      }
      return false;
    } finally {
      if (!silent) setAuthorizationPending(false);
    }
  }, [id, locale, qr, sessionExpired, t]);

  const sendPairingCode = async (intent: Extract<AuthorizationRetry, { kind: "pairing" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/pairing-code`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: JSON.stringify({ phoneNumber: intent.phoneNumber }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { code: string };
      setPairingCode(result.code);
      setAuthorizationRetry(null);
      setDraftDirty("authorization", false);
      setAuthorizationNotice(t("tenant.connection.authorization.pairing.issued"));
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.pairingRequest")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const recordScanComplete = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/scan-complete`,
        { method: "POST", headers: mutationHeaders, body: "{}" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { providerWorkingAt?: string | null };
      setAuthorizationNotice(
        result.providerWorkingAt
          ? t("tenant.connection.authorization.scan.connected")
          : t("tenant.connection.authorization.scan.waiting"),
      );
      await refresh();
    } catch (error) {
      setAuthorizationError(operatorFailureMessage(error, t("tenant.connection.errors.scanAcknowledge")));
    } finally {
      setAuthorizationPending(false);
    }
  };

  const requestPairingCode = () => {
    const phoneNumber = pairingPhone.trim();
    if (!/^\+[1-9]\d{5,19}$/.test(phoneNumber.replace(/[\s()-]/g, ""))) {
      setAuthorizationError(t("tenant.connection.authorization.pairing.invalidNumber"));
      return;
    }
    void sendPairingCode({ kind: "pairing", key: crypto.randomUUID(), phoneNumber });
  };

  const sendPasskey = async (intent: Extract<AuthorizationRetry, { kind: "passkey" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: JSON.stringify({ assertion: intent.assertion }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAuthorizationRetry(null);
      setDraftDirty("authorization", false);
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.accepted"));
      await refresh();
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.passkeySubmit")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const continuePasskey = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/challenge`,
        { cache: "no-store" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const challenge = (await response.json()) as PasskeyChallengePayload;
      if (challenge.rpId !== "web.whatsapp.com") {
        throw operatorLocalFailure(t("tenant.connection.errors.passkeyOrigin"));
      }
      setPasskeyChallenge(challenge);
      const assertion = await signPasskeyWithOfficialExtension(challenge);
      const intent: Extract<AuthorizationRetry, { kind: "passkey" }> = {
        kind: "passkey",
        key: crypto.randomUUID(),
        assertion,
      };
      setAuthorizationPending(false);
      await sendPasskey(intent);
    } catch (error) {
      setAuthorizationError(
        passkeyClientErrorMessage(error, t),
      );
      setAuthorizationPending(false);
    }
  };

  const copyPasskeyChallenge = async () => {
    if (!passkeyChallenge) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(passkeyChallenge, null, 2));
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.challengeCopied"));
      setAuthorizationError(null);
    } catch {
      setAuthorizationError(t("tenant.connection.errors.challengeCopy"));
    }
  };

  const submitManualPasskeyAssertion = () => {
    try {
      const assertion = passkeyAssertionFromUnknown(JSON.parse(manualAssertion));
      void sendPasskey({ kind: "passkey", key: crypto.randomUUID(), assertion });
    } catch {
      setAuthorizationError(t("tenant.connection.errors.assertionInvalid"));
    }
  };

  const loadPasskeyConfirmation = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/confirmation`,
        { cache: "no-store" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { code: string };
      setPasskeyConfirmationCode(result.code);
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.confirmationLoad")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const sendPasskeyConfirmation = async (intent: Extract<AuthorizationRetry, { kind: "confirm" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/confirm`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: "{}",
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAuthorizationRetry(null);
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.confirmationAccepted"));
      await refresh();
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.confirmationSubmit")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const retryAuthorization = () => {
    if (authorizationRetry?.kind === "qr") void loadQr();
    else if (authorizationRetry?.kind === "pairing") void sendPairingCode(authorizationRetry);
    else if (authorizationRetry?.kind === "passkey") void sendPasskey(authorizationRetry);
    else if (authorizationRetry?.kind === "confirm") void sendPasskeyConfirmation(authorizationRetry);
  };

  const state = String(detail?.state ?? "PROVISIONING").toUpperCase();
  const duplicateIdentity = isDuplicateIdentityRejection(detail?.action_reason);
  const providerState = String(
    detail?.provider_state ?? detail?.provider_session_state ?? "",
  ).toUpperCase();
  const transportReady = detail ? connectionTransportIsReady(detail) : false;
  const inboundReady = detail ? connectionInboundIsReady(detail) : false;
  const routingHeld = String(detail?.provider).toUpperCase()==="META" && detail?.meta_routing_configuration_ready!==true;
  const guidanceState = state === "WORKING" ? !transportReady ? "VERIFYING" : routingHeld
    ? detail?.meta_routing_reason==="CONFIGURATION_REQUIRED" ? "META_ROUTING_REQUIRED" : "META_ROUTING_HELD"
    : !inboundReady ? "AWAITING_INBOUND" : state : state;
  const guidance = duplicateIdentity
    ? state === "REVOKED"
      ? {
          titleKey: "tenant.connection.guidance.duplicateRemoved.title",
          bodyKey: "tenant.connection.guidance.duplicateRemoved.body",
        }
      : {
          titleKey: "tenant.connection.guidance.duplicateDetected.title",
          bodyKey: "tenant.connection.guidance.duplicateDetected.body",
        }
    : guidanceState === "WORKING" && String(detail?.provider).toUpperCase() === "META"
      ? { titleKey: "tenant.connection.health.lastVerification", bodyKey: "tenant.connection.health.lastVerificationPassed" }
    : state === "ACTION_REQUIRED" && String(detail?.provider).toUpperCase() === "META"
      ? { titleKey: "tenant.connection.guidance.actionRequired.title", bodyKey: "tenant.connection.guidance.metaActionRequired.body" }
      : CONNECTION_STATE_GUIDANCE[guidanceState] ?? CONNECTION_STATE_GUIDANCE.PROVISIONING;
  const operationState = String(detail?.latest_operation_state ?? "").toUpperCase();
  const operationPending = ["STAGED", "QUEUED", "RUNNING", "FAILED_RETRYABLE"].includes(
    operationState,
  );
  const metaReconnectReview = state === "PAUSED" || (operationPending && detail?.latest_operation_type === "ROTATE_META_CREDENTIAL");
  const lifecycleTransitionPending =
    operationPending ||
    ["PROVISIONING", "CONNECTING"].includes(state) ||
    (state === "AWAITING_AUTH" && ["", "STARTING", "CONNECTING"].includes(providerState));
  const authorizationHealthState = connectionAuthorizationState(detail ?? {});
  useVisibleRefresh(
    (signal) => refresh(signal),
    !actionPending && !authorizationPending && !metaReconnectPending && !metaNumberReleasePending && !disconnecting
      && (dirtyDrafts.size === 0 || (dirtyDrafts.size === 1 && dirtyDrafts.has("reconnect"))),
    lifecycleTransitionPending ? 2_000 : 30_000,
  );
  const closeGuard = useDialogCloseGuard(
    close,
    actionPending || authorizationPending || metaReconnectPending || metaNumberReleasePending,
    dirtyDrafts.size > 0,
    dirtyDrafts,
  );
  const canStart = ["PAUSED", "FAILED", "ACTION_REQUIRED"].includes(state);
  const canRestart = [
    "AWAITING_AUTH",
    "CONNECTING",
    "WORKING",
    "DEGRADED",
    "ACTION_REQUIRED",
    "FAILED",
    "PAUSED",
  ].includes(state);
  const canPause = [
    "AWAITING_AUTH",
    "CONNECTING",
    "WORKING",
    "DEGRADED",
    "ACTION_REQUIRED",
    "FAILED",
  ].includes(state);
  const syncRecoveryNeeded = (
    String(detail?.latest_operation_type ?? "").toUpperCase() === "SYNC_GROUPS" &&
    operationState === "FAILED_TERMINAL"
  ) || (detail?.provider === "META" && !detail.disclosure_version);
  const canSync = syncRecoveryNeeded && ["WORKING", "DEGRADED"].includes(state);
  const canDisconnect = state !== "REVOKED";
  const scanAcknowledgementNeeded =
    detail?.provider === "WAHA" &&
    detail.onboarding_authorization_method === "QR" &&
    Boolean(detail.onboarding_qr_ready_at) &&
    !detail.onboarding_scan_acknowledged_at &&
    ((state === "AWAITING_AUTH" && providerState === "SCAN_QR_CODE") ||
      (state === "WORKING" &&
        providerState === "WORKING" &&
        Boolean(detail.onboarding_working_at)));
  const authorizationNeeded =
    !duplicateIdentity && detail?.provider === "WAHA" &&
    (Boolean(authorizationError || sessionExpired) || scanAcknowledgementNeeded || Boolean(detail?.onboarding_scan_acknowledged_at && authorizationNotice) ||
      ["AWAITING_AUTH", "ACTION_REQUIRED"].includes(state) ||
      [
        "SCAN_QR_CODE",
        "PASSKEY_REQUIRED",
        "PASSKEY_CONFIRMATION_REQUIRED",
      ].includes(providerState));
  const authorizationReady =
    canConfigure && state === "AWAITING_AUTH" && !operationPending;

  useEffect(() => {
    const clear = window.setTimeout(() => {
      if (providerState !== "SCAN_QR_CODE") {
        setQr(null);
        setQrExpanded(false);
        setPairingCode(null);
        setPairingOpen(false);
      }
      if (providerState !== "PASSKEY_CONFIRMATION_REQUIRED") {
        setPasskeyConfirmationCode(null);
      }
      if (providerState !== "PASSKEY_REQUIRED") {
        setPasskeyChallenge(null);
        setManualAssertion("");
        setAdvancedPasskeyOpen(false);
      }
    }, 0);
    return () => window.clearTimeout(clear);
  }, [providerState]);

  useEffect(() => {
    const qrReadyAt = String(detail?.onboarding_qr_ready_at ?? "");
    if (
      !qrReadyAt ||
      autoLoadedQrReadyAt.current === qrReadyAt ||
      autoLoadingQrReadyAt.current === qrReadyAt ||
      autoQrRetryTimer.current !== null ||
      !canConfigure ||
      state !== "AWAITING_AUTH" ||
      providerState !== "SCAN_QR_CODE" ||
      operationPending ||
      authorizationPending ||
      qr ||
      sessionExpired
    ) return;
    autoLoadingQrReadyAt.current = qrReadyAt;
    void loadQr().then((loaded) => {
      if (!autoQrActive.current) return;
      autoLoadingQrReadyAt.current = null;
      if (loaded) {
        autoLoadedQrReadyAt.current = qrReadyAt;
        return;
      }
      autoQrRetryTimer.current = window.setTimeout(() => {
        autoQrRetryTimer.current = null;
        setQrPollAttempt((attempt) => attempt + 1);
      }, 2_000);
    });
  }, [authorizationPending, canConfigure, detail?.onboarding_qr_ready_at, loadQr, operationPending, providerState, qr, qrPollAttempt, sessionExpired, state]);

  useEffect(() => {
    if (!qr) return;
    const timer = window.setInterval(() => setQrClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [qr]);

  useEffect(() => {
    if (!qr || providerState !== "SCAN_QR_CODE" || sessionExpired) return;
    const expiresAt = qr.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
    const delay = expiresAt > Date.now()
      ? Math.max(1_000, expiresAt - Date.now() + 750)
      : 5_000;
    const timer = window.setTimeout(() => void loadQr(true), delay);
    return () => window.clearTimeout(timer);
  }, [loadQr, providerState, qr, qrPollAttempt, sessionExpired]);

  const qrExpiresAt = qr?.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
  const qrExpired = Boolean(qr && (qr.expired || !qrExpiresAt || qrClock >= qrExpiresAt));
  useEffect(() => {
    const clear = window.setTimeout(() => {
      if (!qr?.imageDataUrl || qrExpired) setQrExpanded(false);
    }, 0);
    return () => window.clearTimeout(clear);
  }, [qr?.imageDataUrl, qrExpired]);
  const lifecycleActionText = (value: unknown) => {
    const action = String(value ?? "").toLowerCase();
    if (action === "verify_meta_billing") return t("tenant.connection.payment.check");
    return t(["start", "restart", "pause", "sync", "disconnect"].includes(action)
      ? `tenant.connection.lifecycle.action.${action}`
      : "tenant.connection.lifecycle.action.operation");
  };
  const connectionReturnTo = `/app?view=connections&connection=${encodeURIComponent(id)}`;
  const signInHref = `/auth/login?return_to=${encodeURIComponent(connectionReturnTo)}`;
  return (
    <ModalDialog
      close={closeGuard.requestClose}
      className="modal-backdrop"
      aria-label={t("tenant.connection.detailsLabel")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeGuard.requestClose();
      }}
    >
      <div className="modal connection-detail-shell" data-unsaved={dirtyDrafts.size > 0 || undefined}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t("tenant.connection.control")}</span>
            <h2>{detail?.name ? <bdi dir="auto">{detail.name}</bdi> : t("tenant.connection.detailsLabel")}</h2>
            <p>
              {detail
                ? <>{connectionMethod(detail.provider, t)} · <bdi dir="ltr">{String(detail.phone_e164 ?? detail.phone ?? t("tenant.connection.numberPending"))}</bdi></>
                : t("tenant.connection.loadingLatestState")}
            </p>
          </div>
          <button type="button" onClick={closeGuard.requestClose} aria-label={t("tenant.connection.closeDetails")}>
            ×
          </button>
        </div>
        <DirtyCloseConfirmation guard={closeGuard} />

        {loading ? (
          <div className="connection-detail-loading" role="status" aria-live="polite">
            <span className="radar">
              <i />
            </span>
            <b>{t("tenant.connection.loadingState")}</b>
            <small>{t("tenant.connection.loadingStateBody")}</small>
          </div>
        ) : loadError && !detail ? (
          <div className="connection-detail-error" role="alert">
            <span className="warning-box">!</span>
            <div>
              <b>{t("tenant.connection.unavailable")}</b>
              <p>{loadError}</p>
              {sessionExpired ? (
                <a className="button small secondary" href={signInHref}>{t("tenant.connection.signInAgain")}</a>
              ) : (
                <button className="button small" onClick={() => void reload()}>
                  {t("common.actions.retry")}
                </button>
              )}
            </div>
          </div>
        ) : detail ? (
          <div className="connection-detail-body">
            {loadError ? (
              <div className="connection-detail-alert connection-detail-alert-warning" role={sessionExpired ? "alert" : "status"}>
                {sessionExpired
                  ? t("tenant.connection.sessionExpiredStatePreserved")
                  : t("tenant.connection.refreshFailedStatePreserved", { message: loadError })}
                {sessionExpired ? (
                  <a className="button small secondary" href={signInHref}>{t("tenant.connection.signInAgain")}</a>
                ) : (
                  <button onClick={() => void refresh()}>{t("tenant.connection.retryRefresh")}</button>
                )}
              </div>
            ) : null}

            <section className="connection-detail-state" aria-labelledby="connection-state-title">
              <div>
                <Status value={state === "WORKING" && !transportReady ? "CONNECTING" : state} />
                <h3 id="connection-state-title">{t(guidance.titleKey)}</h3>
                <p>{t(guidance.bodyKey)}</p>
              </div>
            </section>

            {detail.provider === "META" && state === "REVOKED" && canConfigure && !sessionExpired ? <Suspense fallback={<SectionLoading quiet />}><MetaNumberRelease
              tenantId={tenantId} actorId={actorId} connectionId={id} connectionName={String(detail.name ?? "")} mutationHeaders={mutationHeaders} busyChanged={setMetaNumberReleasePending}
            /></Suspense> : null}

            {detail.action_reason && (detail.state !== "PAUSED" || duplicateIdentity) ? (
              <div className="connection-detail-alert connection-detail-alert-danger" role="alert">
                <span>!</span>
                <div>
                  <b>{t(duplicateIdentity ? "tenant.connection.duplicateDetails" : "tenant.connection.actionReason")}</b>
                  <p>{t(duplicateIdentity
                    ? state === "REVOKED"
                      ? "tenant.connection.guidance.duplicateRemoved.body"
                      : "tenant.connection.guidance.duplicateDetected.body"
                    : "tenant.errors.connectionReview")}</p>
                </div>
              </div>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="connection-health-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="connection-health-title">{t("tenant.connection.health.title")}</h3>
                  <p>{t("tenant.connection.health.body")}</p>
                </div>
              </div>
              <dl className="connection-detail-facts">
                <div>
                  <dt>{t(String(detail.provider).toUpperCase()==="META" ? "tenant.connection.health.lastVerification" : "tenant.connection.health.lastHealth")}</dt>
                  <dd title={exactTime(detail.last_heartbeat_at, locale, t("tenant.time.invalid"))}>
                    <RelativeTime value={detail.last_heartbeat_at} pastOnly/>
                  </dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.lastConnection")}</dt>
                  <dd title={exactTime(detail.last_provider_event_at, locale, t("tenant.time.invalid"))}>
                    <RelativeTime value={detail.last_provider_event_at} pastOnly/>
                  </dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.managedGroups")}</dt>
                  <dd>{formatNumber(Number(detail.group_count ?? 0), locale)}</dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.secureRoute")}</dt>
                  <dd>{String(detail.webhook_state ?? "").toUpperCase() === "ACTIVE" ? t("tenant.connection.protected") : t("tenant.connection.notReported")}</dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.authorization")}</dt>
                  <dd>{authorizationState(authorizationHealthState, t)}</dd>
                </div>
                {detail.onboarding_provider_seconds !== null && detail.onboarding_provider_seconds !== undefined ? (
                  <div>
                    <dt>{t("tenant.connection.health.connectionTime")}</dt>
                    <dd>{t("tenant.connection.seconds", { count: formatNumber(Math.round(Number(detail.onboarding_provider_seconds)), locale) })}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("tenant.connection.health.mode")}</dt>
                  <dd>{t(String(detail.engine).toUpperCase() === "NOWEB" ? "tenant.connection.mode.compatibility" : "tenant.connection.mode.recommended")}</dd>
                </div>
              </dl>
            </section>

            {authorizationNeeded ? (
              <section className="connection-detail-section connection-detail-authorization" aria-labelledby="authorization-title">
                <div className="connection-detail-section-head">
                  <div>
                    <h3 id="authorization-title">{t("tenant.connection.authorization.title")}</h3>
                    <p>{t("tenant.connection.authorization.body")}</p>
                  </div>
                  <span>{authorizationState(authorizationHealthState,t)}</span>
                </div>
                {!canConfigure ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.ownerRequired")}
                  </p>
                ) : operationPending ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.waitForLifecycle")}
                  </p>
                ) : scanAcknowledgementNeeded && state === "WORKING" ? (
                  <div className="connection-detail-auth-step">
                    <div className="connection-detail-note" role="status">
                      <b>{t("tenant.connection.authorization.scan.connectedTitle")}</b>
                      <p>{t("tenant.connection.authorization.scan.connectedBody")}</p>
                      <button
                        className="button small secondary connection-detail-qr-restart"
                        disabled={authorizationPending}
                        onClick={() => void recordScanComplete()}
                      >
                        {t("tenant.connection.authorization.scan.finished")}
                      </button>
                    </div>
                  </div>
                ) : state === "WORKING" && detail.onboarding_scan_acknowledged_at && authorizationNotice ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.scan.recorded")}
                  </p>
                ) : state !== "AWAITING_AUTH" ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.unavailableForState", { state: connectionStateText(state, t) })}
                  </p>
                ) : providerState === "SCAN_QR_CODE" ? (
                  <div className="connection-detail-auth-step">
                    {qr && !qrExpired && qr.imageDataUrl ? (
                      <div className="connection-detail-qr" role="group" aria-label={t("tenant.connection.authorization.qr.currentLabel")}>
                        <button
                          type="button"
                          className={`connection-detail-qr-image${qrExpanded ? " is-expanded" : ""}`}
                          aria-expanded={qrExpanded}
                          aria-label={t(qrExpanded ? "tenant.connection.authorization.qr.reduce" : "tenant.connection.authorization.qr.expand")}
                          onClick={() => setQrExpanded((value) => !value)}
                        >
                          {/* A validated, no-store PNG data URL is the only image shape accepted by the API. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={qr.imageDataUrl} alt={t("tenant.connection.authorization.qr.alt")} />
                        </button>
                        <div>
                          <b>{t("tenant.connection.authorization.qr.scanTitle")}</b>
                          <p>{t("tenant.connection.authorization.qr.scanBody")}</p>
                          <div className="connection-detail-qr-expiry">
                            <span>{t("tenant.connection.authorization.qr.sequence", { current: formatNumber(qr.sequence, locale), total: formatNumber(6, locale) })}</span>
                            <time dateTime={qr.expiresAt ?? undefined} title={exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid"))}>
                              {t("tenant.connection.authorization.qr.validFor", { duration: qrCountdown(qrExpiresAt - qrClock, locale) })}
                            </time>
                            <small>{t("tenant.connection.authorization.qr.issued", { time: exactTimeWithSeconds(qr.issuedAt, locale, t("tenant.time.invalid")) })}</small>
                            <small>{t("tenant.connection.authorization.qr.until", { time: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) })}</small>
                          </div>
                          <button
                            className="button small secondary connection-detail-qr-restart"
                            disabled={authorizationPending || Boolean(detail.onboarding_scan_acknowledged_at)}
                            onClick={() => void recordScanComplete()}
                          >
                            {t(detail.onboarding_scan_acknowledged_at ? "tenant.connection.authorization.scan.acknowledged" : "tenant.connection.authorization.scan.finished")}
                          </button>
                        </div>
                      </div>
                    ) : qr ? (
                      <div className="connection-detail-qr connection-detail-qr-expired" role="status" aria-live="polite">
                        <span aria-hidden="true">!</span>
                        <div>
                          <b>{t("tenant.connection.authorization.qr.expiredTitle")}</b>
                          <p>{qr.expiresAt ? t("tenant.connection.authorization.qr.expiredAt", { time: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) }) : t("tenant.connection.authorization.qr.expiredUnknown")}</p>
                          {canConfigure ? (
                            <button
                              className="button small secondary connection-detail-qr-restart"
                              disabled={actionPending || operationPending || sessionExpired}
                              onClick={() => void runAction("restart")}
                            >
                              {t("tenant.connection.authorization.qr.restart")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void loadQr()}
                      >
                        {authorizationPending
                          ? t("tenant.connection.authorization.qr.refreshing")
                          : qrExpired
                            ? t("tenant.connection.authorization.qr.checkNew")
                            : qr
                              ? t("tenant.connection.authorization.qr.refresh")
                              : t("tenant.connection.authorization.qr.show")}
                      </button>
                      <button
                        className="button secondary"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => setPairingOpen((value) => !value)}
                      >
                        {t("tenant.connection.authorization.pairing.useInstead")}
                      </button>
                    </div>
                    {pairingOpen ? (
                      <div className="connection-detail-pairing">
                        <label>
                          {t("tenant.connection.authorization.pairing.number")}
                          <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            placeholder={t("tenant.connection.authorization.pairing.numberExample")}
                            value={pairingPhone}
                            onChange={(event) => {
                              setPairingPhone(event.target.value);
                              setDraftDirty("authorization", event.target.value.length > 0);
                            }}
                            disabled={authorizationPending}
                          />
                        </label>
                        <button
                          className="button"
                          disabled={!pairingPhone.trim() || authorizationPending}
                          onClick={requestPairingCode}
                        >
                          {t("tenant.connection.authorization.pairing.request")}
                        </button>
                      </div>
                    ) : null}
                    {pairingCode ? (
                      <div className="connection-detail-auth-code" role="status" aria-live="polite">
                        <small>{t("tenant.connection.authorization.pairing.codeLabel")}</small>
                        <code><bdi dir="ltr">{pairingCode}</bdi></code>
                        <p>{t("tenant.connection.authorization.pairing.codeBody")}</p>
                      </div>
                    ) : null}
                  </div>
                ) : providerState === "PASSKEY_REQUIRED" ? (
                  <div className="connection-detail-auth-step">
                    <p className="connection-detail-note">
                      {t("tenant.connection.authorization.passkey.intro")}
                    </p>
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void continuePasskey()}
                      >
                        {t("tenant.connection.authorization.passkey.continueExtension")}
                      </button>
                      <a
                        className="button secondary"
                        href="https://chromewebstore.google.com/detail/ghpdcgnjffaaekflfpcgkgpbafmjldcp"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("tenant.connection.authorization.passkey.installChromium")}
                      </a>
                      <a
                        className="button secondary"
                        href="https://addons.mozilla.org/firefox/addon/whatsapp-browser-extension/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("tenant.connection.authorization.passkey.installFirefox")}
                      </a>
                    </div>
                    <p className="connection-detail-note">
                      {t("tenant.connection.authorization.passkey.extensionBoundary")}
                    </p>
                    <button
                      className="text-button connection-detail-advanced-toggle"
                      onClick={() => setAdvancedPasskeyOpen((value) => !value)}
                    >
                      {t(advancedPasskeyOpen ? "tenant.connection.authorization.passkey.hideAdvanced" : "tenant.connection.authorization.passkey.showAdvanced")}
                    </button>
                    {advancedPasskeyOpen ? (
                      <div className="connection-detail-passkey-advanced">
                        <div className="connection-detail-alert connection-detail-alert-warning">
                          <span>!</span>
                          <div>
                            <b>{t("tenant.connection.authorization.passkey.advancedTitle")}</b>
                            <p>{t("tenant.connection.authorization.passkey.advancedBody")}</p>
                          </div>
                        </div>
                        <ol>
                          <li>{t("tenant.connection.authorization.passkey.stepFetch")}</li>
                          <li>{t("tenant.connection.authorization.passkey.stepSign")}</li>
                          <li>{t("tenant.connection.authorization.passkey.stepPaste")}</li>
                        </ol>
                        <div className="connection-detail-authorization-actions">
                          <button
                            className="button secondary"
                            disabled={!passkeyChallenge || authorizationPending}
                            onClick={() => void copyPasskeyChallenge()}
                          >
                            {t("tenant.connection.authorization.passkey.copyChallenge")}
                          </button>
                          <a
                            className="button secondary"
                            href="https://waha.devlike.pro/blog/waha-passkey/"
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("tenant.connection.authorization.passkey.openGuide")}
                          </a>
                        </div>
                        {passkeyChallenge ? (
                          <textarea
                            className="connection-detail-challenge"
                            value={JSON.stringify(passkeyChallenge, null, 2)}
                            readOnly
                            aria-label={t("tenant.connection.authorization.passkey.challengeLabel")}
                            spellCheck={false}
                          />
                        ) : null}
                        <label>
                          {t("tenant.connection.authorization.passkey.assertionLabel")}
                          <textarea
                            value={manualAssertion}
                            onChange={(event) => {
                              setManualAssertion(event.target.value);
                              setDraftDirty("authorization", event.target.value.length > 0);
                            }}
                            placeholder={t("tenant.connection.authorization.passkey.assertionPlaceholder")}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </label>
                        <button
                          className="button"
                          disabled={!manualAssertion.trim() || authorizationPending}
                          onClick={submitManualPasskeyAssertion}
                        >
                          {t("tenant.connection.authorization.passkey.submitAssertion")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : providerState === "PASSKEY_CONFIRMATION_REQUIRED" ? (
                  <div className="connection-detail-auth-step">
                    {passkeyConfirmationCode ? (
                      <div className="connection-detail-auth-code" role="status" aria-live="polite">
                        <small>{t("tenant.connection.authorization.passkey.confirmationCode")}</small>
                        <code><bdi dir="ltr">{passkeyConfirmationCode}</bdi></code>
                        <p>{t("tenant.connection.authorization.passkey.confirmationBody")}</p>
                      </div>
                    ) : null}
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button secondary"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void loadPasskeyConfirmation()}
                      >
                        {t(passkeyConfirmationCode ? "tenant.connection.authorization.passkey.refreshCode" : "tenant.connection.authorization.passkey.showCode")}
                      </button>
                      <button
                        className="button"
                        disabled={!authorizationReady || !passkeyConfirmationCode || authorizationPending}
                        onClick={() => void sendPasskeyConfirmation({ kind: "confirm", key: crypto.randomUUID() })}
                      >
                        {t("tenant.connection.authorization.passkey.confirmCode")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.refreshForAction")}
                  </p>
                )}
                {authorizationPending ? (
                  <p className="connection-detail-note" role="status" aria-live="polite">
                    {t("tenant.connection.authorization.completing")}
                  </p>
                ) : null}
                {authorizationNotice ? (
                  <div className="connection-detail-alert connection-detail-alert-success connection-detail-auth-feedback" role="status" aria-live="polite">
                    <span>✓</span>
                    <p>{typeof authorizationNotice === "string" ? authorizationNotice : !qr || qrExpired
                      ? t("tenant.connection.authorization.qr.notReady")
                      : t("tenant.connection.authorization.qr.refreshed", { expiresAt: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) })}</p>
                  </div>
                ) : null}
                {authorizationError || sessionExpired ? (
                  <div className="connection-detail-alert connection-detail-alert-danger connection-detail-auth-feedback" role="alert">
                    <span>!</span>
                    <div>
                      <b>{t("tenant.connection.authorization.failedTitle")}</b>
                      <p>{authorizationError ?? t("tenant.connection.authorization.signInRequired")}</p>
                      <div className="connection-detail-inline-actions">
                        {authorizationRetry ? (
                          <button
                            className="button small"
                            disabled={authorizationPending}
                            onClick={retryAuthorization}
                          >
                            {t("tenant.actions.retrySameRequest")}
                          </button>
                        ) : null}
                        {sessionExpired ? (
                          <a className="button small secondary" href={signInHref}>
                            {t("tenant.connection.signInAgain")}
                          </a>
                        ) : null}
                        <button
                          className="text-button"
                          onClick={() => {
                            setAuthorizationError(null);
                            setAuthorizationRetry(null);
                          }}
                        >
                          {t("tenant.connection.dismiss")}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {detail.provider === "WAHA" && canReadSettings ? (
              <WahaGroupInitiationPolicy
                connectionId={id}
                canWrite={canWriteSettings}
                mutationHeaders={mutationHeaders}
                draftChanged={setSafetyDraftDirty}
              />
            ) : null}

            {detail.provider === "META" ? (
              <Suspense fallback={<SectionLoading />}>
                {!sessionExpired ? <MetaTemplatePreparation connectionId={id} tenantId={tenantId} actorId={actorId} canWrite={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {!sessionExpired ? <MetaLegacyMigration connectionId={id} tenantId={tenantId} actorId={actorId} canWrite={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {canConfigure && state !== "REVOKED" ? <div className="connection-detail-section">
                  {metaReconnectOpen && !sessionExpired ? null : <div className="connection-detail-section-head"><div>
                    <h3 id="meta-reconnect-title">{t("tenant.metaSignup.reconnect.title")}</h3>
                    <p>{t("tenant.metaSignup.reconnect.body")}</p>
                  </div></div>}
                  {metaReconnectOpen && !sessionExpired ? <Suspense fallback={<SectionLoading />}><MetaSignup
                    key={id} name={t("tenant.metaSignup.reconnect.title")} target={{ connectionId: id, name: String(detail.name ?? ""), canPrepare: state === "PAUSED" && !operationPending, canContinue: state === "PAUSED" }}
                    isTargetConnectionRevoked={() => metaReconnectTargetRevoked.current}
                    mutationHeaders={mutationHeaders} busyChanged={setMetaReconnectPending}
                    created={() => {
                      setMetaReconnectOpen(false); setDraftDirty("reconnect", false);
                      setMetaCredentialRevision(revision => revision + 1); void refresh();
                      restoreMetaReconnectFocus.current = true;
                    }}
                    back={() => {
                      setMetaReconnectOpen(false); setDraftDirty("reconnect", false);
                      restoreMetaReconnectFocus.current = true;
                    }}
                  /></Suspense> : <>
                    {metaReconnectReview && !sessionExpired ? <button ref={metaReconnectTrigger} type="button" className="button secondary"
                      disabled={actionPending || authorizationPending || dirtyDrafts.size > 0}
                      onClick={() => { setMetaReconnectOpen(true); setDraftDirty("reconnect", true); }}>
                      {t("tenant.metaSignup.reconnect.open")}
                    </button> : !sessionExpired ? <p role="status">{t("tenant.metaSignup.reason.META_SIGNUP_RECONNECT_PAUSE_REQUIRED")}</p> : null}
                    {dirtyDrafts.size > 0 ? <p>{t("tenant.metaSignup.reconnect.finishChanges")}</p> : null}
                  </>}
                </div> : null}
                {!metaReconnectOpen && state !== "REVOKED" ? <MetaCredentialRotation
                  connectionId={id}
                  canConfigure={canConfigure}
                  mutationHeaders={mutationHeaders}
                  draftChanged={(dirty) => setDraftDirty("credential", dirty)}
                  rotated={async () => {
                    setDraftDirty("credential", false);
                    setMetaCredentialRevision((revision) => revision + 1);
                    await refresh();
                  }}
                /> : null}
                {canConfigure && !sessionExpired ? <MetaCoexistence connectionId={id} mutationHeaders={mutationHeaders} /> : null}
                <MetaBillingDiagnostics key={id} connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} />
                <MetaCustomerPaymentPolicy key={`policy-${tenantId}-${actorId}-${id}`} tenantId={tenantId} actorId={actorId} connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} />
                {!sessionExpired ? <MetaRoutingConfiguration connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {!metaReconnectOpen ? <MetaSavedAccessActivation connectionId={id} canConfigure={canConfigure} connectionRevoked={state === "REVOKED"}
                  mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} changed={refresh}/> : null}
                <MetaOfficialGroups
                  connectionId={id}
                  connectionState={state}
                  canConfigure={canConfigure}
                  mutationHeaders={mutationHeaders}
                  refreshKey={metaCredentialRevision + (detail.disclosure_version ? 1 : 0)}
                  draftChanged={(dirty) => setDraftDirty("group", dirty)}
                  committed={() => setDraftDirty("group", false)}
                />
              </Suspense>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="latest-operation-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="latest-operation-title">{t("tenant.connection.latestOperation.title")}</h3>
                  <p>{t("tenant.connection.latestOperation.body")}</p>
                </div>
                {detail.latest_operation_state ? (
                  <Status value={detail.latest_operation_state} />
                ) : null}
              </div>
              {detail.latest_operation_id ? (
                <div className="connection-detail-operation">
                  <span>
                    <small>{t("tenant.connection.latestOperation.operation")}</small>
                    <b>{lifecycleActionText(detail.latest_operation_type)}</b>
                  </span>
                  <span>
                    <small>{t("tenant.connection.latestOperation.attempts")}</small>
                    <b>{formatNumber(Number(detail.latest_operation_attempts ?? 0), locale)}</b>
                  </span>
                  <span>
                    <small>{t("tenant.connection.latestOperation.requested")}</small>
                    <b><RelativeTime value={detail.latest_operation_created_at} pastOnly/></b>
                  </span>
                </div>
              ) : (
                <Empty
                  title={t("tenant.connection.latestOperation.emptyTitle")}
                  body={t("tenant.connection.latestOperation.emptyBody")}
                />
              )}
              {detail.latest_operation_safe_error ? (
                <p className="connection-detail-operation-error" role="alert">
                  {t("tenant.errors.operationUnavailable")}
                </p>
              ) : null}
            </section>

            {notice ? (
              <div className="connection-detail-alert connection-detail-alert-success" role="status" aria-live="polite">
                <span>✓</span>
                <p>{notice}</p>
              </div>
            ) : null}
            {actionError ? (
              <div className="connection-detail-alert connection-detail-alert-danger" role="alert">
                <span>!</span>
                <div>
                  <b>{t("tenant.connection.requestFailedTitle")}</b>
                  <p>{actionError}</p>
                  <div className="connection-detail-inline-actions">
                    {requiresPrivilegedReauthentication(actionError) ? (
                      <a className="button small secondary" href={privilegedStepUpHref(`/app?view=connections&connection=${encodeURIComponent(id)}`)}>
                        {t("tenant.connection.reauthenticate")}
                      </a>
                    ) : null}
                    {retryIntent ? (
                      <button
                        className="button small"
                        disabled={actionPending}
                        onClick={() => void runAction(retryIntent.action, retryIntent)}
                      >
                        {t("tenant.actions.retrySameRequest")}
                      </button>
                    ) : null}
                    <button
                      className="text-button"
                      onClick={() => {
                        setActionError(null);
                        setRetryIntent(null);
                      }}
                    >
                      {t("tenant.connection.dismiss")}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="lifecycle-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="lifecycle-title">{t("tenant.connection.lifecycle.title")}</h3>
                  <p>{t("tenant.connection.lifecycle.body")}</p>
                  {detail.provider === "WAHA" ? <p>{t("tenant.connection.lifecycle.automaticGroups")}</p> : null}
                </div>
              </div>
              {duplicateIdentity ? (
                <p className="connection-detail-note">
                  {t("tenant.connection.lifecycle.duplicateDisabled")}
                </p>
              ) : !canConfigure ? (
                <p className="connection-detail-note">
                  {t("tenant.connection.lifecycle.readOnly")}
                </p>
              ) : (
                <div className="connection-detail-lifecycle-actions">
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canStart || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("start")}
                    title={!canStart ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.start"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.start")}
                  </button>
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canRestart || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("restart")}
                    title={!canRestart ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.restart"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.restart")}
                  </button>
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canPause || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("pause")}
                    title={!canPause ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.pause"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.pause")}
                  </button>
                  {detail.provider === "META" && !detail.disclosure_version ? (
                    <label className="check">
                      <input type="checkbox" checked={metaGroupsAccepted}
                        disabled={metaReconnectOpen || operationPending || actionPending || Boolean(retryIntent)}
                        onChange={(event) => { setMetaGroupsAccepted(event.target.checked); setDraftDirty("group", event.target.checked); }} />
                      {t("tenant.setup.review.metaGroupsAccept")}
                    </label>
                  ) : null}
                  {syncRecoveryNeeded ? (
                    <button
                      className="button"
                      disabled={metaReconnectOpen || !canSync || operationPending || actionPending || authorizationPending || (detail.provider === "META" && !detail.disclosure_version && !metaGroupsAccepted)}
                      onClick={() => void runAction("sync")}
                      title={!canSync ? t("tenant.connection.lifecycle.syncUnavailable") : undefined}
                    >
                      {t("tenant.connection.lifecycle.action.sync")}
                    </button>
                  ) : null}
                </div>
              )}
              {operationPending ? (
                <p className="connection-detail-note" role="status">
                  {t("tenant.connection.lifecycle.pending", { action: lifecycleActionText(detail.latest_operation_type), state: connectionStateText(operationState, t) })}
                </p>
              ) : null}
            </section>

            {canConfigure && canDisconnect ? (
              <section className="connection-detail-section connection-detail-danger" aria-labelledby="disconnect-title">
                <div className="connection-detail-section-head">
                  <div>
                    <h3 id="disconnect-title">{t("tenant.connection.disconnect.title")}</h3>
                    <p>{t("tenant.connection.disconnect.body")}</p>
                  </div>
                  {!disconnecting ? (
                    <button
                      className="button connection-detail-danger-button"
                      disabled={metaReconnectOpen || operationPending || actionPending || authorizationPending}
                      ref={disconnectTrigger}
                      onClick={() => setDisconnecting(true)}
                    >
                      {t("tenant.connection.disconnect.open")}
                    </button>
                  ) : null}
                </div>
                {disconnecting ? (
                  <div className="connection-detail-disconnect">
                    <label>
                      {t("tenant.connection.disconnect.typePrefix")} <code>{t("tenant.connection.disconnect.phrase")}</code> {t("tenant.connection.disconnect.typeSuffix")}
                      <input
                        ref={disconnectInput}
                        value={confirmation}
                        onChange={(event) => {
                          setConfirmation(event.target.value);
                          setDraftDirty("disconnect", event.target.value.length > 0);
                        }}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <div>
                      <button
                        className="button secondary"
                        onClick={() => {
                          restoreDisconnectFocus.current = true;
                          setDisconnecting(false);
                          setConfirmation("");
                          setDraftDirty("disconnect", false);
                        }}
                      >
                        {t("common.actions.cancel")}
                      </button>
                      <button
                        className="button connection-detail-danger-button"
                        disabled={metaReconnectOpen || confirmation !== "DISCONNECT" || actionPending || authorizationPending}
                        onClick={() => void runAction("disconnect")}
                      >
                        {t("tenant.connection.disconnect.confirm")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

type WahaOutboundPolicy={
  connection_id:string;enabled:boolean;inbound_response_only:boolean;allow_human_group_workspace_initiation:boolean;
  response_window_seconds:number;connection_capacity:number;connection_refill_tokens:number;connection_refill_seconds:number;
  number_capacity:number;number_refill_tokens:number;number_refill_seconds:number;minimum_spacing_seconds:number;version:number;
};

function WahaGroupInitiationPolicy({connectionId,canWrite,mutationHeaders,draftChanged}:{connectionId:string;canWrite:boolean;mutationHeaders:Record<string,string>;draftChanged:(dirty:boolean)=>void}){
  const{t}=useI18n();const[policy,setPolicy]=useState<WahaOutboundPolicy|null>(null);const[enabled,setEnabled]=useState(false);const[reason,setReason]=useState("");const[loading,setLoading]=useState(true);const[pending,setPending]=useState(false);const[error,setError]=useState<string|null>(null);const[notice,setNotice]=useState<string|null>(null);const toggleRef=useRef<HTMLButtonElement>(null);const loadGeneration=useRef(0);const saveAttempt=useRef<{fingerprint:string;key:string}|null>(null);
  const dirty=Boolean(policy&&enabled!==policy.allow_human_group_workspace_initiation);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{const generation=++loadGeneration.current;if(!background)setLoading(true);try{const response=await fetch("/api/waha-outbound-safety",{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const body=await response.json() as{policies?:WahaOutboundPolicy[]};const next=body.policies?.find(item=>item.connection_id===connectionId);if(!next)throw operatorLocalFailure(t("tenant.connection.sendPolicy.unavailable"));if(signal?.aborted||generation!==loadGeneration.current)return;setPolicy(next);setEnabled(next.allow_human_group_workspace_initiation);setReason("");setError(null)}catch(loadError){if(isAbortError(loadError)||signal?.aborted||generation!==loadGeneration.current)return;setError(operatorFailureMessage(loadError, t("tenant.connection.sendPolicy.errors.load")))}finally{if(!background&&generation===loadGeneration.current)setLoading(false)}},[connectionId,t]);
  useEffect(()=>{const controller=new AbortController();const timer=window.setTimeout(()=>void load(false,controller.signal),0);return()=>{controller.abort();window.clearTimeout(timer)}},[load]);
  useVisibleRefresh(signal=>load(true,signal),!dirty&&!pending);
  useEffect(()=>{draftChanged(dirty);return()=>draftChanged(false)},[dirty,draftChanged]);
  const focusAfterSave=useRef(false);
  useEffect(()=>{
    if(!pending&&!dirty&&focusAfterSave.current){
      focusAfterSave.current=false;
      toggleRef.current?.focus({preventScroll:true});
    }
  },[pending,dirty]);
  const restoreToggleFocus=()=>window.requestAnimationFrame(()=>toggleRef.current?.focus({preventScroll:true}));
  const discard=()=>{setEnabled(policy?.allow_human_group_workspace_initiation??false);setReason("");setError(null);setNotice(null);saveAttempt.current=null;restoreToggleFocus()};
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!policy||!dirty||!canWrite||pending||reason.trim().length<3)return;const body={connectionId,expectedVersion:policy.version,enabled:policy.enabled,inboundResponseOnly:policy.inbound_response_only,allowHumanGroupWorkspaceInitiation:enabled,responseWindowSeconds:policy.response_window_seconds,connectionCapacity:policy.connection_capacity,connectionRefillTokens:policy.connection_refill_tokens,connectionRefillSeconds:policy.connection_refill_seconds,numberCapacity:policy.number_capacity,numberRefillTokens:policy.number_refill_tokens,numberRefillSeconds:policy.number_refill_seconds,minimumSpacingSeconds:policy.minimum_spacing_seconds,reason:reason.trim()};const fingerprint=JSON.stringify(body);if(saveAttempt.current?.fingerprint!==fingerprint)saveAttempt.current={fingerprint,key:crypto.randomUUID()};setPending(true);setError(null);setNotice(null);try{const response=await fetch("/api/waha-outbound-safety",{method:"PATCH",headers:{...mutationHeaders,"idempotency-key":saveAttempt.current.key},body:fingerprint});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as WahaOutboundPolicy;saveAttempt.current=null;setPolicy(next);setEnabled(next.allow_human_group_workspace_initiation);setReason("");setNotice(t("tenant.connection.sendPolicy.saved"));focusAfterSave.current=true}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.connection.sendPolicy.errors.save")))}finally{setPending(false)}};
  return <section className="connection-detail-section" aria-labelledby="waha-send-policy-title"><div className="connection-detail-section-head"><div><h3 id="waha-send-policy-title">{t("tenant.connection.sendPolicy.title")}</h3><p>{t("tenant.connection.sendPolicy.body")}</p></div></div>{loading?<p className="connection-detail-note" role="status">{t("tenant.connection.sendPolicy.loading")}</p>:policy?<form data-unsaved={dirty||undefined} onSubmit={save}><div className="setting-row settings-toggle-row"><span><b>{t("tenant.connection.sendPolicy.initiationTitle")}</b><small id="waha-group-initiation-help">{t("tenant.connection.sendPolicy.initiationBody")}</small></span><button ref={toggleRef} type="button" className={`switch ${enabled?"on":""}`} aria-pressed={enabled} aria-expanded={dirty} aria-controls="waha-send-policy-change" aria-describedby="waha-group-initiation-help" aria-label={t("tenant.connection.sendPolicy.initiationToggle")} disabled={!canWrite||pending} onClick={()=>{setEnabled(value=>!value);setReason("");setError(null);setNotice(null)}}><span/></button></div>{dirty?<div id="waha-send-policy-change" role="status" aria-live="polite"><label htmlFor="waha-send-policy-reason">{t("tenant.connection.sendPolicy.reason")}<input id="waha-send-policy-reason" value={reason} minLength={3} maxLength={500} required dir="auto" aria-describedby="waha-send-policy-reason-help" onChange={event=>setReason(event.target.value)}/><small id="waha-send-policy-reason-help">{t("tenant.connection.sendPolicy.reasonHelp")}</small></label></div>:null}{!canWrite?<p className="connection-detail-note">{t("tenant.connection.sendPolicy.readOnly")}</p>:null}{error?<div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><p>{error}</p></div>:null}{notice?<div className="connection-detail-alert connection-detail-alert-success" role="status" aria-live="polite"><span>✓</span><p>{notice}</p></div>:null}{dirty?<div className="connection-detail-inline-actions"><button type="button" className="button secondary" disabled={pending} onClick={discard}>{t("tenant.settings.actions.discard")}</button><button className="button primary" type="submit" disabled={pending||reason.trim().length<3}>{t(pending?"tenant.settings.actions.saving":"tenant.settings.actions.save")}</button></div>:null}</form>:<div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><div><b>{t("tenant.connection.sendPolicy.unavailableTitle")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("common.actions.retry")}</button></div></div>}</section>;
}

function MetaCredentialRotation({
  connectionId,
  canConfigure,
  mutationHeaders,
  draftChanged,
  rotated,
}: {
  connectionId: string;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  draftChanged: (dirty: boolean) => void;
  rotated: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [accessToken, setAccessToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attemptToken, setAttemptToken] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const inputId = `meta-access-token-${connectionId}`;
  const helpId = `${inputId}-help`;

  const replace = async () => {
    const token = attemptToken ?? accessToken;
    if (!canConfigure || token.length < 16 || pending) return;
    setAttemptToken(token);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/credentials`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": idempotencyKey },
          body: JSON.stringify({ accessToken: token }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAccessToken("");
      setAttemptToken(null);
      setIdempotencyKey(crypto.randomUUID());
      setNotice(t("tenant.connection.metaCredential.success"));
      await rotated();
    } catch (requestError) {
      setError(
        operatorFailureMessage(requestError, t("tenant.connection.metaCredential.error")),
      );
    } finally {
      setPending(false);
    }
  };

  const resetAttempt = () => {
    if (pending) return;
    setAccessToken("");
    setAttemptToken(null);
    setIdempotencyKey(crypto.randomUUID());
    setError(null);
    setNotice(null);
    draftChanged(false);
  };

  return (
    <section className="connection-detail-section" aria-labelledby={`${inputId}-title`}>
      <div className="connection-detail-section-head">
        <div>
          <h3 id={`${inputId}-title`}>{t("tenant.connection.metaCredential.title")}</h3>
          <p>{t("tenant.connection.metaCredential.body")}</p>
        </div>
      </div>
      {canConfigure ? (
        <form
          className="meta-credential-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void replace();
          }}
        >
          <label className="meta-token-field" htmlFor={inputId}>
            {t("tenant.connection.metaCredential.label")}
            <small id={helpId}>{t("tenant.connection.metaCredential.help")}</small>
            <input
              id={inputId}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              required
              minLength={16}
              maxLength={4096}
              aria-describedby={helpId}
              value={accessToken}
              disabled={pending || attemptToken !== null}
              onChange={(event) => {
                setAccessToken(event.target.value);
                draftChanged(event.target.value.length > 0);
              }}
            />
          </label>
          <div className="connection-detail-inline-actions">
            {attemptToken !== null && !pending ? (
              <button className="button secondary" type="button" onClick={resetAttempt}>
                {t("tenant.dialog.discard.confirm")}
              </button>
            ) : null}
            <button
              className="button primary"
              type="submit"
              disabled={pending || accessToken.length < 16}
            >
              {t(pending
                ? "tenant.connection.metaCredential.replacing"
                : attemptToken !== null
                  ? "tenant.actions.retrySameRequest"
                  : "tenant.connection.metaCredential.replace")}
            </button>
          </div>
        </form>
      ) : (
        <p className="connection-detail-note">{t("tenant.connection.metaCredential.readOnly")}</p>
      )}
      {notice ? (
        <div className="connection-detail-alert connection-detail-alert-success meta-groups-feedback" role="status" aria-live="polite">
          <span>✓</span><p>{notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.metaCredential.errorTitle")}</b>
            <p>{error}</p>
            {requiresPrivilegedReauthentication(error) ? (
              <a className="button small secondary" href={privilegedStepUpHref(`/app?view=connections&connection=${encodeURIComponent(connectionId)}`)}>
                {t("tenant.connection.reauthenticate")}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

type MetaCapabilityView = MetaGroupsCapability;

function MetaOfficialGroups({
  connectionId,
  connectionState,
  canConfigure,
  mutationHeaders,
  refreshKey,
  draftChanged,
  committed,
}: {
  connectionId: string;
  connectionState: string;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  refreshKey: number;
  draftChanged: (dirty: boolean) => void;
  committed: () => void;
}) {
  const { locale, t } = useI18n();
  const [capability, setCapability] = useState<MetaCapabilityView | null>(null);
  const [loadingCapability, setLoadingCapability] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [joinApprovalMode, setJoinApprovalMode] = useState<
    "approval_required" | "auto_approve"
  >("approval_required");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const capabilityRequest = useRef<ReturnType<typeof createReplaceableRequestController> | null>(null);
  const requests = capabilityRequest.current ??= createReplaceableRequestController();

  const loadCapability = useCallback(async () => {
    const controller = requests.begin();
    setLoadingCapability(true);
    setCapabilityError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/capabilities`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = (await response.json()) as MetaCapabilityView;
      if (controller.signal.aborted) return;
      setCapability(next);
    } catch (error) {
      if (controller.signal.aborted) return;
      setCapability(null);
      setCapabilityError(
        operatorFailureMessage(error, t("tenant.connection.officialGroups.errors.eligibility")),
      );
    } finally {
      requests.finish(controller);
      if (!controller.signal.aborted) setLoadingCapability(false);
    }
  }, [connectionId, requests, t]);

  useEffect(() => {
    if (connectionState !== "WORKING" && connectionState !== "DEGRADED") return;
    const timer = window.setTimeout(() => void loadCapability(), 0);
    return () => {
      requests.abort();
      window.clearTimeout(timer);
    };
  }, [connectionState, loadCapability, refreshKey, requests]);

  const createGroup = async () => {
    if (!capability?.eligible || !canConfigure || !subject.trim()) return;
    setCreating(true);
    setCreateError(null);
    setCreateNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/groups`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": createKey },
          body: JSON.stringify({
            subject: subject.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            joinApprovalMode,
          }),
        },
      );
      if (!response.ok) {
        // The server records a rejected create under its key; a definite rejection needs a fresh key so a corrected retry is not replayed as the same failure.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setCreateKey(crypto.randomUUID());
        throw operatorLocalFailure(await apiError(response));
      }
      const accepted = (await response.json()) as {
        requestId?: string;
        duplicate?: boolean;
      };
      setCreateNotice(
        t(accepted.duplicate
          ? "tenant.connection.officialGroups.existingAccepted"
          : "tenant.connection.officialGroups.newAccepted"),
      );
      setSubject("");
      setDescription("");
      setCreateKey(crypto.randomUUID());
      committed();
    } catch (error) {
      setCreateError(
        operatorFailureMessage(error, t("tenant.connection.officialGroups.errors.create")),
      );
    } finally {
      setCreating(false);
    }
  };

  const canProbe = connectionState === "WORKING" || connectionState === "DEGRADED";
  return (
    <section className="connection-detail-section meta-groups-panel" aria-labelledby="meta-groups-title">
      <div className="connection-detail-section-head">
        <div>
          <h3 id="meta-groups-title">{t("tenant.connection.officialGroups.title")}</h3>
          <p>{t("tenant.connection.officialGroups.body")}</p>
        </div>
        {capability ? <Status value={capability.state} /> : null}
      </div>
      {!canProbe ? (
        <p className="connection-detail-note">
          {t("tenant.connection.officialGroups.waitForConnection")}
        </p>
      ) : loadingCapability ? (
        <p className="connection-detail-note" role="status">{t("tenant.connection.officialGroups.verifying")}</p>
      ) : capabilityError ? (
        <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.officialGroups.unverifiedTitle")}</b>
            <p>{t("tenant.connection.officialGroups.unverifiedBody", { message: capabilityError })}</p>
            <button className="button small" onClick={() => void loadCapability()}>
              {t("tenant.connection.officialGroups.checkAgain")}
            </button>
          </div>
        </div>
      ) : capability?.state === "CONSENT_REQUIRED" ? (
        <p className="connection-detail-note">{t("tenant.connection.officialGroups.consentRequired")}</p>
      ) : capability && !capability.eligible ? (
        <div className="connection-detail-alert connection-detail-alert-warning meta-groups-feedback" role="status">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.officialGroups.unavailableTitle")}</b>
            <p>{t("tenant.connection.officialGroups.unavailableBody")}</p>
            <button className="button small" onClick={() => void loadCapability()}>
              {t("tenant.connection.officialGroups.recheck")}
            </button>
          </div>
        </div>
      ) : capability?.eligible ? (
        <>
          <ul className="meta-constraints" aria-label={t("tenant.connection.officialGroups.constraintsLabel")}>
            <li>{t("tenant.connection.officialGroups.businessAccountRequired")}</li>
            <li>{t("tenant.connection.officialGroups.inviteOnly")}</li>
            <li>{t("tenant.connection.officialGroups.maxParticipants", { count: formatNumber(capability.constraints.maxParticipants, locale) })}</li>
            <li>{t("tenant.connection.officialGroups.unsupportedNumbers")}</li>
          </ul>
          {canConfigure ? (
            <div className="meta-group-form">
              <label>
                {t("tenant.connection.officialGroups.subject")}
                <input
                  dir="auto"
                  value={subject}
                  maxLength={128}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSubject(next);
                    draftChanged(Boolean(next || description || joinApprovalMode !== "approval_required"));
                  }}
                  placeholder={t("tenant.connection.officialGroups.subjectPlaceholder")}
                />
              </label>
              <label>
                {t("tenant.connection.officialGroups.joinApproval")}
                <select
                  value={joinApprovalMode}
                  onChange={(event) => {
                    const next = event.target.value as "approval_required" | "auto_approve";
                    setJoinApprovalMode(next);
                    draftChanged(Boolean(subject || description || next !== "approval_required"));
                  }}
                >
                  <option value="approval_required">{t("tenant.connection.officialGroups.approvalRequired")}</option>
                  <option value="auto_approve">{t("tenant.connection.officialGroups.autoApprove")}</option>
                </select>
              </label>
              <label className="meta-description-field">
                {t("tenant.connection.officialGroups.description")} <small>{t("tenant.connection.optional")}</small>
                <textarea
                  dir="auto"
                  value={description}
                  maxLength={2048}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDescription(next);
                    draftChanged(Boolean(subject || next || joinApprovalMode !== "approval_required"));
                  }}
                  placeholder={t("tenant.connection.officialGroups.descriptionPlaceholder")}
                />
              </label>
              <div className="meta-group-actions">
                <a href={capability.documentationUrl} target="_blank" rel="noreferrer">
                  {t("tenant.connection.officialGroups.requirements")}
                </a>
                <button
                  className="button primary"
                  disabled={creating || !subject.trim()}
                  onClick={() => void createGroup()}
                >
                  {t(creating ? "tenant.connection.officialGroups.requesting" : "tenant.connection.officialGroups.create")}
                </button>
              </div>
            </div>
          ) : (
            <p className="connection-detail-note">{t("tenant.connection.officialGroups.readOnly")}</p>
          )}
          {createNotice ? (
            <div className="connection-detail-alert connection-detail-alert-success meta-groups-feedback" role="status">
              <span>✓</span><p>{createNotice}</p>
            </div>
          ) : null}
          {createError ? (
            <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
              <span>!</span>
              <div>
                <b>{t("tenant.connection.officialGroups.requestFailedTitle")}</b>
                <p>{createError}</p>
                <button className="button small" disabled={creating} onClick={() => void createGroup()}>
                  {t("tenant.actions.retrySameRequest")}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function ConnectionModal({
  close,
  mutationHeaders,
  dashboardChanged,
  created,
}: {
  close: () => void;
  mutationHeaders: Record<string, string>;
  dashboardChanged: () => Promise<boolean>;
  created: (id: string) => void;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<"waha" | "meta">("waha");
  const [step, setStep] = useState(1);
  const [creating, setCreating] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState(() => t("tenant.setup.defaultName"));
  const nameValid = Boolean(name.trim()) && (provider !== "meta" || (name.trim().length <= 100 && !/\p{Cc}/u.test(name)));
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [metaManual, setMetaManual] = useState(false);
  const [metaPurpose, setMetaPurpose] = useState<"NEW_NUMBER" | "ADD_ACCESS">("NEW_NUMBER");
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaWabaId, setMetaWabaId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [assetConflict, setAssetConflict] = useState(false);
  const [result, setResult] = useState<{
    id: string;
    state?: string;
    operation?: { id?: string; state?: string };
  } | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const closeGuard = useDialogCloseGuard(close, creating);
  const metaConfigurationReady =
    /^\d{5,32}$/u.test(metaPhoneNumberId) &&
    /^\d{5,32}$/u.test(metaWabaId) &&
    metaAccessToken.length >= 16;
  const create = async () => {
    if (
      (provider === "waha" && !accepted) ||
      !nameValid ||
      (provider === "meta" && !metaConfigurationReady)
    ) return;
    setCreating(true);
    setError(null);
    setAssetConflict(false);
    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          provider,
          name: name.trim(),
          engine: provider === "waha" ? "GOWS" : undefined,
          disclosureAccepted: provider === "waha" ? accepted : undefined,
          disclosureVersion: provider === "waha" ? "2026-08-09" : undefined,
          accessToken: provider === "meta" ? metaAccessToken : undefined,
          phoneNumberId: provider === "meta" ? metaPhoneNumberId : undefined,
          wabaId: provider === "meta" ? metaWabaId : undefined,
          eligibilityAccepted: provider === "meta" && accepted ? true : undefined,
          eligibilityVersion: provider === "meta" && accepted ? "2026-08-09" : undefined,
        }),
      });
      if (!response.ok) {
        if (provider === "meta" && response.status === 409) {
          const failure = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
          if (failure?.code === "META_SIGNUP_ASSET_CONFLICT") {
            setAssetConflict(true);
            throw operatorLocalFailure(t("tenant.metaSignup.reason.META_SIGNUP_ASSET_CONFLICT"));
          }
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const acceptedResult = (await response.json()) as {
        id: string;
        state?: string;
        operation?: { id?: string; state?: string };
      };
      setResult(acceptedResult);
      setStep(4);
      closeGuard.resetDirty();
      void dashboardChanged();
    } catch (requestError) {
      setError(
        operatorFailureMessage(requestError, t("tenant.setup.errors.request")),
      );
    } finally {
      // Provider credentials live only in this transient setup form. The
      // control plane stores the accepted token in the private secret manager.
      setMetaAccessToken("");
      setCreating(false);
    }
  };
  return (
    <ModalDialog
      close={closeGuard.requestClose}
      focusVersion={step}
      className="modal-backdrop"
      aria-label={t("tenant.setup.ariaLabel")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeGuard.requestClose();
      }}
    >
      <div
        className="modal connection-modal"
        data-unsaved={closeGuard.dirty || undefined}
        onChangeCapture={closeGuard.markDirty}
      >
        <div className="modal-head">
          <div>
            {provider === "meta" && step === 2 && !metaManual ? null : <span className="eyebrow">
              {t("tenant.setup.eyebrow", { step: Math.min(step, 3) })}
            </span>}
            <h2 data-modal-initial-focus tabIndex={-1}>
              {step === 1
                ? t("tenant.setup.steps.chooseTitle")
                : step === 2
                  ? t("tenant.setup.steps.reviewTitle")
                  : step === 3
                    ? t("tenant.setup.steps.readyTitle")
                    : t("tenant.setup.steps.startedTitle")}
            </h2>
            <p>
              {step === 1
                ? t("tenant.setup.steps.chooseBody")
                : step === 2
                  ? t("tenant.setup.steps.reviewBody")
                  : step === 3
                    ? t("tenant.setup.steps.readyBody")
                    : t("tenant.setup.steps.startedBody")}
            </p>
          </div>
          <button type="button" aria-label={t("tenant.setup.actions.close")} onClick={closeGuard.requestClose}>×</button>
        </div>
        <DirtyCloseConfirmation guard={closeGuard} />
        {step === 1 ? (
          <>
            <fieldset className="provider-options">
              <legend className="sr-only">{t("tenant.setup.ariaLabel")}</legend>
              <label
                className={provider === "waha" ? "selected" : ""}
              >
                <input className="sr-only" type="radio" name="connection-provider" value="waha" checked={provider === "waha"} onChange={() => { setProvider("waha"); setAccepted(false); }} />
                <span className="provider-big" aria-hidden="true">W</span>
                <span>
                  <b>{t("tenant.setup.providers.linkedTitle")}</b>
                  <small>{t("tenant.setup.providers.linkedBody")}</small>
                  <em>{t("tenant.setup.providers.linkedMeta")}</em>
                </span>
                <i aria-hidden="true">✓</i>
              </label>
              <label className={provider === "meta" ? "selected" : ""}>
                <input className="sr-only" type="radio" name="connection-provider" value="meta" aria-describedby="meta-connector-status" checked={provider === "meta"} onChange={() => { setProvider("meta"); setAccepted(false); }} />
                <span className="provider-big meta" aria-hidden="true">M</span>
                <span>
                  <b>{t("tenant.setup.providers.metaTitle")}</b>
                  <small>{t("tenant.setup.providers.metaBody")}</small>
                  <em id="meta-connector-status">
                    {t("tenant.setup.providers.metaMeta")}
                  </em>
                </span>
                <i aria-hidden="true">✓</i>
              </label>
            </fieldset>
            {provider === "waha" ? (
              <section className="waha-engine-selector" aria-labelledby="qualified-waha-engine">
                <h3 id="qualified-waha-engine">{t("tenant.setup.mode.legend")}</h3>
                <div>
                  <div className="selected">
                    <span>
                      <b>{t("tenant.setup.mode.recommended")}</b>
                      <em>{t("tenant.setup.mode.default")}</em>
                      <small>{t("tenant.setup.mode.recommendedBody")}</small>
                    </span>
                  </div>
                </div>
              </section>
            ) : null}
            <label>
              {t("tenant.setup.name.label")}
              <input
                required
                maxLength={provider === "meta" ? 100 : 160}
                value={name}
                dir="auto"
                aria-invalid={!nameValid || undefined}
                aria-describedby="connection-name-help"
                onChange={(event) => setName(event.target.value)}
                placeholder={t("tenant.setup.name.placeholder")}
              />
              <small id="connection-name-help">{t(provider === "meta" ? "tenant.metaSignup.nameHelp" : "tenant.setup.name.help")}</small>
            </label>
          </>
        ) : step === 2 && provider === "meta" && !metaManual ? (
          <>
          <fieldset className="provider-options" disabled={creating}>
            <legend>{t("tenant.metaSignup.addAccess.purposeLabel")}</legend>
            {(["NEW_NUMBER", "ADD_ACCESS"] as const).map(value => <label key={value} className="check">
              <input type="radio" name="meta-connection-purpose" value={value} checked={metaPurpose === value} onChange={() => setMetaPurpose(value)} />
              <span>{t(`tenant.metaSignup.addAccess.purpose.${value}`)}</span>
            </label>)}
          </fieldset>
          <Suspense fallback={<SectionLoading />}><MetaSignup name={name} purpose={metaPurpose} mutationHeaders={mutationHeaders} busyChanged={setCreating}
            created={(id) => { closeGuard.resetDirty(); void dashboardChanged(); created(id); }}
            back={() => setStep(1)} manual={() => setMetaManual(true)} /></Suspense>
          </>
        ) : step === 2 ? (
          <div className="meta-setup-step">
            <div className="disclosure">
              <span className="warning-box">!</span>
              <div>
                <b>
                  {provider === "waha"
                    ? t("tenant.setup.review.linkedTitle")
                    : t("tenant.setup.review.metaTitle")}
                </b>
                <p>
                  {provider === "waha"
                    ? t("tenant.setup.review.linkedBody")
                    : t("tenant.setup.review.metaBody")}
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />{" "}
                  {t(provider === "meta" ? "tenant.setup.review.metaGroupsAccept" : "tenant.setup.review.accept")}
                </label>
              </div>
            </div>
            {provider === "meta" ? (
              <div className="meta-credential-grid">
                <label>
                  {t("tenant.setup.meta.phoneId")}
                  <input
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={32}
                    value={metaPhoneNumberId}
                    onChange={(event) => setMetaPhoneNumberId(event.target.value.trim())}
                    placeholder={t("tenant.setup.meta.phoneIdPlaceholder")}
                  />
                </label>
                <label>
                  {t("tenant.setup.meta.wabaId")}
                  <input
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={32}
                    value={metaWabaId}
                    onChange={(event) => setMetaWabaId(event.target.value.trim())}
                    placeholder={t("tenant.setup.meta.wabaIdPlaceholder")}
                  />
                </label>
                <label className="meta-token-field">
                  {t("tenant.setup.meta.token")}
                  <input
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={4096}
                    value={metaAccessToken}
                    onChange={(event) => setMetaAccessToken(event.target.value)}
                    placeholder={t("tenant.setup.meta.tokenPlaceholder")}
                  />
                  <small>
                    {t("tenant.setup.meta.tokenHelp")}
                  </small>
                </label>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ready-state">
            <span className={`radar ${step === 4 && result?.state === "WORKING" ? "" : "neutral"}`}>
              <i />
            </span>
            <h3>
              {step === 4
                ? t("tenant.setup.ready.requestedTitle")
                : t("tenant.setup.ready.planTitle")}
            </h3>
            <p>
              {step === 4
                ? provider === "meta"
                  ? t("tenant.setup.ready.metaAccepted")
                  : t("tenant.setup.ready.linkedAccepted")
                : t("tenant.setup.ready.next")}
            </p>
            <div>
              <span>{t("tenant.setup.ready.mode")}</span>
              <b>{provider === "waha" ? t("tenant.setup.mode.recommended") : t("tenant.setup.ready.official")}</b>
            </div>
            {provider === "waha" ? (
              <div>
                <span>{t("tenant.setup.ready.capacity")}</span>
                <b>{t("tenant.setup.ready.capacityValue")}</b>
              </div>
            ) : null}
            <div>
              <span>{t("tenant.setup.ready.protection")}</span>
              <b>{t("tenant.setup.ready.protectionValue")}</b>
            </div>
            {result?.operation ? (
              <div>
                <span>{t("tenant.setup.ready.status")}</span>
                <b><Status value={result.operation.state ?? "QUEUED"} /></b>
              </div>
            ) : null}
          </div>
        )}
        {error ? (
          <div className="disclosure" role="alert">
            <span className="warning-box">!</span>
            <div>
              <b>{t("tenant.setup.errors.title")}</b>
              <p>{error}</p>
              {!assetConflict && (
                <small>
                  {t("tenant.setup.errors.retry")}{provider === "meta" ? ` ${t("tenant.setup.errors.reenterToken")}` : ""}
                </small>
              )}
            </div>
          </div>
        ) : null}
        {step === 2 && provider === "meta" && !metaManual ? null : <div className="modal-actions">
          {step < 4 && (
            <button
              className="button secondary"
              onClick={() => { if (step === 1) { closeGuard.requestClose(); return; } if (step === 2) setMetaManual(false); setStep(step - 1); }}
            >
              {t(step === 1 ? "tenant.setup.actions.cancel" : "tenant.setup.actions.back")}
            </button>
          )}
          <button
            className="button primary"
            disabled={
              creating ||
              (step === 1 && !nameValid) ||
              (step === 2 && ((provider === "waha" && !accepted) || (provider === "meta" && !metaConfigurationReady))) ||
              (provider === "meta" && step === 3 && !metaConfigurationReady)
            }
            onClick={() =>
              step < 3
                ? (setError(null), setStep(step + 1))
                : step === 3
                  ? create()
                  : result
                    ? created(result.id)
                    : closeGuard.requestClose()
            }
          >
            {step < 3
              ? t("tenant.setup.actions.continue")
              : step === 3
                ? creating
                  ? t("tenant.setup.actions.creating")
                  : t("tenant.setup.actions.start")
                : t("tenant.setup.actions.view")}
          </button>
        </div>}
      </div>
    </ModalDialog>
  );
}
