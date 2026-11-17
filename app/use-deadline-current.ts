"use client";
import { useEffect, useState } from "react";

/** UI expiry only; mutations still recheck the wall clock and server authority. */
export function useDeadlineCurrent(expiresAt: string | null | undefined) {
  const deadline = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  const [clock, setClock] = useState<{ deadline: number; now: number } | null>(null);
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (!alive) return;
      clearTimeout(timer);
      const now = Date.now();
      setClock(previous => ({ deadline, now: previous?.deadline === deadline ? Math.max(previous.now, now) : now }));
      if (now < deadline) timer = setTimeout(update, Math.min(deadline - now, 2_147_483_647));
    };
    // Initial and replaced deadlines fail closed until this clock sample arrives.
    queueMicrotask(update);
    const visible = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", update);
    window.addEventListener("pageshow", update);
    return () => {
      alive = false; clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", update);
      window.removeEventListener("pageshow", update);
    };
  }, [deadline]);
  return clock !== null && clock.deadline === deadline && clock.now < deadline;
}
