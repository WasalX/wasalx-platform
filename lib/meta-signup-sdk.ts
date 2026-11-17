import type { MetaSignupSdk } from "./meta-signup-contract";
import type { MetaSignupSessionLogRequest } from "./meta-coexistence-contract";
export type MetaSignupSdkConfiguration = MetaSignupSdk;
type SessionDiagnostic = Pick<MetaSignupSessionLogRequest, "event" | "sessionInfoVersion" | "sourceOrigin">;

type MetaSdk = {
  init: (configuration: { appId: string; version: string; cookie: false; xfbml: false; autoLogAppEvents: false }) => void;
  login: (callback: (response: unknown) => void, options: {
    config_id: string; response_type: "code"; override_default_response_type: true; extras: { setup: Record<string, never>; featureType?: "whatsapp_business_app_onboarding"; sessionInfoVersion?: "3" };
  }) => void;
};

let loaded: Promise<MetaSdk> | undefined;
let initializedFor: string | undefined;

/** Only load when the operator opens Meta setup; do not load Meta on other portal pages. */
export function loadMetaSignupSdk(configuration: MetaSignupSdkConfiguration): Promise<MetaSdk> {
  if (!/^\d{5,32}$/u.test(configuration.appId) || !/^\d{5,32}$/u.test(configuration.configId)
    || !/^v\d+\.\d+$/u.test(configuration.graphVersion)) return Promise.reject(new Error("META_SIGNUP_CONFIGURATION"));
  const key = `${configuration.appId}:${configuration.graphVersion}`;
  if (initializedFor && initializedFor !== key) return Promise.reject(new Error("META_SIGNUP_CONFIGURATION_CHANGED"));
  initializedFor = key;
  loaded ??= new Promise<MetaSdk>((resolve, reject) => {
    let settled = false;
    const host = window as Window & { FB?: MetaSdk };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      reject(new Error("META_SIGNUP_SDK_UNAVAILABLE"));
    };
    const timer = setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      if (settled) return;
      clearTimeout(timer);
      if (!host.FB) return fail();
      try {
        host.FB.init({ appId: configuration.appId, version: configuration.graphVersion,
          cookie: false, xfbml: false, autoLogAppEvents: false });
        settled = true;
        resolve(host.FB);
      } catch { fail(); }
    };
    document.head.appendChild(script);
  });
  // Failed loads remain failed for this document. An explicit page reload can
  // reattempt after the browser/network prerequisite has been repaired.
  return loaded;
}

/** Call synchronously from a click. FB.login does not return a popup handle. */
export function launchMetaSignup(sdk: MetaSdk, configuration: MetaSignupSdkConfiguration,
  isCurrent: () => boolean, completed: (code: string | null) => void, diagnostic?: (value: SessionDiagnostic) => void) {
  const businessApp = configuration.variant === "BUSINESS_APP";
  if (businessApp && (configuration.extras?.featureType !== "whatsapp_business_app_onboarding"
    || configuration.extras.sessionInfoVersion !== "3" || !configuration.extras.setup
    || Object.keys(configuration.extras.setup).length !== 0)) throw new Error("META_SIGNUP_CONFIGURATION");
  let delivered = false;
  let listenerActive = businessApp && Boolean(diagnostic);
  let pinnedSource: MessageEventSource | null = null;
  const cleanup = () => {
    if (listenerActive) window.removeEventListener("message", sessionMessage);
    listenerActive = false;
  };
  function sessionMessage(message: MessageEvent) {
    if (!listenerActive || !isCurrent() || delivered || !["https://www.facebook.com", "https://web.facebook.com"].includes(message.origin)) return;
    // WindowProxy.window is cross-origin readable. Ports, workers, self and null
    // cannot be advisory popup sources. This is not exact-popup authentication.
    try { if (!message.source || message.source === window || (message.source as Window).window !== message.source) return; }
    catch { return; }
    if (pinnedSource && pinnedSource !== message.source) return;
    let value: unknown;
    try {
      const serialized = typeof message.data === "string" ? message.data : JSON.stringify(message.data);
      if (typeof serialized !== "string" || serialized.length > 8192) return;
      value = JSON.parse(serialized);
    } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    if (input.type !== "WA_EMBEDDED_SIGNUP" || input.version !== 3 || typeof input.event !== "string"
      || !["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "CANCEL", "ERROR"].includes(input.event)
      || !input.data || typeof input.data !== "object" || Array.isArray(input.data)) return;
    const data = input.data as Record<string, unknown>;
    if ((input.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" && (typeof data.waba_id !== "string" || !/^\d{5,32}$/u.test(data.waba_id)))
      || (data.current_step !== undefined && (typeof data.current_step !== "string" || data.current_step.length > 100))
      || (data.error_message !== undefined && (typeof data.error_message !== "string" || data.error_message.length > 1024))
      || (data.session_id !== undefined && (typeof data.session_id !== "string" || data.session_id.length > 200))
      || (data.error_code !== undefined && typeof data.error_code !== "string" && typeof data.error_code !== "number")
      || (data.timestamp !== undefined && typeof data.timestamp !== "string" && typeof data.timestamp !== "number")) return;
    pinnedSource = message.source;
    // Each allowlisted event is terminal for diagnostic collection only. Asset
    // hints and raw errors are discarded; the SDK callback remains independent.
    cleanup();
    try { diagnostic?.({ event: input.event as SessionDiagnostic["event"], sessionInfoVersion: "3", sourceOrigin: message.origin as SessionDiagnostic["sourceOrigin"] }); }
    catch { /* Optional diagnostics cannot affect the independent SDK callback. */ }
  }
  if (listenerActive) window.addEventListener("message", sessionMessage);
  try {
    sdk.login((response) => {
      cleanup();
      if (delivered || !isCurrent()) return;
      delivered = true;
      const code = typeof response === "object" && response !== null && "authResponse" in response
        && typeof response.authResponse === "object" && response.authResponse !== null && "code" in response.authResponse
        ? response.authResponse.code : undefined;
      completed(typeof code === "string" && code.length > 0 && code.length <= 4096 ? code : null);
    }, { config_id: configuration.configId, response_type: "code", override_default_response_type: true,
      extras: businessApp ? { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } : { setup: {} } });
  } catch (failure) { cleanup(); throw failure; }
  return cleanup;
}
