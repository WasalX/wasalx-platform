"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MailboxSettings } from "./MailboxSettings";
import { useI18n } from "./I18nProvider";
import { createLatestRequestFence } from "../lib/operator-ui";

export function MailboxAdministration({ execute, scope }: {
  execute: <T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<T>; scope: string;
}) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const lifecycle = useRef({ mounted: false, generation: 0 });
  const fence = useRef(createLatestRequestFence());
  const inFlight = useRef(false);
  useEffect(() => {
    const state = lifecycle.current, requests = fence.current;
    state.mounted = true;
    return () => { state.mounted = false; state.generation++; requests.invalidate(); };
  }, []);
  const [reauthenticate, setReauthenticate] = useState(false);
  const load = useCallback(async (before?: string, signal?: AbortSignal) => {
    const execution = fence.current.begin();
    try {
      const page = await execute<{ items: Array<{ id: string; name: string; active: boolean }>; next_cursor: string | null }>("TEAM_LIST", { limit: 100, ...(before ? { before } : {}) }, signal);
      if (signal?.aborted || !lifecycle.current.mounted || !fence.current.isCurrent(execution)) return;
      const active = page.items.filter(team => team.active);
      setTeams(current => before ? [...current, ...active.filter(team => !current.some(item => item.id === team.id))] : active);
      setCursor(page.next_cursor); setError(false);
    } catch (cause) {
      if (signal?.aborted || !lifecycle.current.mounted || !fence.current.isCurrent(execution)) return;
      if ((cause as { code?: string }).code === "REAUTHENTICATION_REQUIRED") setReauthenticate(true);
      else if ([401, 403].includes((cause as { status?: number }).status ?? 0)) { fence.current.invalidate(); setTeams([]); setCursor(null); }
      setError(true);
    }
  }, [execute]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(undefined, controller.signal).catch(() => { if (!controller.signal.aborted) setError(true); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  return <>
    <MailboxSettings execute={execute} scope={scope} teams={teams} />
    {error ? <p className="settings-feedback error" role="alert">{t("mailboxes.teamsFailed")}</p> : null}
    {reauthenticate ? <a className="button secondary wx-button" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dsettings">{t("tenant.privacy.action.reauthenticate")}</a> : null}
    {cursor || error ? <button type="button" className="button secondary" disabled={loading} onClick={() => {
      if (inFlight.current) return;
      const generation = lifecycle.current.generation;
      inFlight.current = true; setLoading(true);
      void load(error ? undefined : cursor ?? undefined).catch(() => { if (lifecycle.current.mounted && lifecycle.current.generation === generation) setError(true); })
        .finally(() => { if (lifecycle.current.mounted && lifecycle.current.generation === generation) { inFlight.current = false; setLoading(false); } });
    }}>{t(error ? "common.actions.retry" : "teamsAdmin.more")}</button> : null}
  </>;
}
