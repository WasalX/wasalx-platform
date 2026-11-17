"use client";

import { useEffect, useState } from "react";
import type { Locale } from "../../../lib/i18n/locales.ts";
import { InvitationShell } from "../InvitationShell";
import type { PublicHeaderCopy } from "../../PublicHeader";
import styles from "../../public-access.module.css";
import { MarketingIcon } from "../../MarketingIcon";

type State = "preparing" | "invalid" | "unavailable";

export type InvitationAcceptanceCopy = {
  brand: string;
  header: PublicHeaderCopy;
  preparingTitle: string;
  preparingDetail: string;
  invalidTitle: string;
  invalidDetail: string;
  unavailableTitle: string;
  unavailableDetail: string;
  verifying: string;
  retry: string;
  signInInstead: string;
  securityNote: string;
};

export function InvitationAcceptance({
  locale,
  copy,
}: {
  locale: Locale;
  copy: InvitationAcceptanceCopy;
}) {
  const [state, setState] = useState<State>("preparing");

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let controller: AbortController | null = null;
    const begin = async () => {
      const current = ++generation;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      setState("preparing");
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
      const token = fragment.get("token");
      if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
        window.history.replaceState(null, "", window.location.pathname);
        setState("invalid");
        return;
      }
      try {
        const response = await fetch("/api/invitations/accept/start", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
          signal: requestController.signal,
        });
        const result = await response.json() as { authorizeUrl?: string };
        if (cancelled || current !== generation || requestController.signal.aborted) return;
        if (!response.ok || !result.authorizeUrl) {
          if (!cancelled && current === generation) setState(response.status === 400 ? "invalid" : "unavailable");
          return;
        }
        const authorizationUrl = new URL(result.authorizeUrl);
        authorizationUrl.searchParams.set("ui_locales", locale);
        result.authorizeUrl = authorizationUrl.toString();
        // Remove the one-time value before leaving this page. It has already
        // been sealed into an HttpOnly, short-lived transaction cookie.
        window.history.replaceState(null, "", window.location.pathname);
        if (cancelled || current !== generation || requestController.signal.aborted) return;
        window.location.assign(result.authorizeUrl);
      } catch (error) {
        if (!cancelled && current === generation && !(error instanceof DOMException && error.name === "AbortError")) setState("unavailable");
      }
    };
    const handleHashChange = () => void begin();
    // Returning with Back from the identity provider restores this page from the back/forward cache after the one-time value was removed.
    const handlePageShow = (event: PageTransitionEvent) => { if (event.persisted) setState("invalid"); };
    window.addEventListener("hashchange", handleHashChange);
    window.addEventListener("pageshow", handlePageShow);
    void begin();
    return () => { cancelled = true; controller?.abort(); window.removeEventListener("hashchange", handleHashChange); window.removeEventListener("pageshow", handlePageShow); };
  }, [locale]);

  const content = state === "preparing"
    ? {
        symbol: "→",
        title: copy.preparingTitle,
        detail: copy.preparingDetail,
      }
    : state === "invalid"
      ? {
          symbol: "!",
          title: copy.invalidTitle,
          detail: copy.invalidDetail,
        }
      : {
          symbol: "↻",
          title: copy.unavailableTitle,
          detail: copy.unavailableDetail,
        };

  return (
    <InvitationShell className={styles.page} locale={locale} header={copy.header}>
      <section className={styles.panel} aria-live="polite" aria-busy={state === "preparing"}>
        <div className={styles.icon} data-state={state} aria-hidden="true">{state === "preparing" ? <span className="wx-spinner"/> : <MarketingIcon name={state === "invalid" ? "link" : "alert"}/>}</div>
        <h1>{content.title}</h1>
        <p>{content.detail}</p>
        {state === "preparing" ? (
          <div className={styles.progress}><span className="wx-spinner" aria-hidden="true" /> {copy.verifying}</div>
        ) : state === "unavailable" ? (
          <button className="wx-button wx-button-primary" type="button" onClick={() => window.location.reload()}>{copy.retry}</button>
        ) : (
          <a className="wx-button" href="/auth/login?return_to=/app">{copy.signInInstead}</a>
        )}
        <small>{copy.securityNote}</small>
      </section>
    </InvitationShell>
  );
}
