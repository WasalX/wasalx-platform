"use client";

import { useEffect, useRef } from "react";

export function useVisibleRefresh(
  refresh: (signal?: AbortSignal) => void | Promise<void>,
  enabled = true,
  intervalMs = 30_000,
) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    let active: AbortController | null = null;
    let frame: number | null = null;
    let refreshAfterCurrent = false;
    const run = () => {
      frame = null;
      // A slow request must be allowed to finish, even when its duration exceeds
      // the polling interval. Visibility changes and cleanup still cancel it.
      if (active || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      active = controller;
      void Promise.resolve()
        .then(() => { if (!controller.signal.aborted) return latest.current(controller.signal); })
        .catch(() => undefined)
        .finally(() => {
          if (active !== controller) return;
          active = null;
          if (refreshAfterCurrent) {
            refreshAfterCurrent = false;
            schedule();
          }
        });
    };
    const schedule = (event?: Event) => {
      if(document.visibilityState!=="visible"){
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        active?.abort();
        active = null;
        refreshAfterCurrent = false;
        return;
      }
      // A request started before returning to the page may already have read stale data.
      if (active && event) {
        refreshAfterCurrent = true;
        return;
      }
      if (frame === null) frame = window.requestAnimationFrame(run);
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) schedule(event); };
    const timer = window.setInterval(schedule, intervalMs);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus",schedule);
    window.addEventListener("pageshow",restore);
    return () => {
      active?.abort();
      active = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus",schedule);
      window.removeEventListener("pageshow",restore);
    };
  }, [enabled, intervalMs]);
}
