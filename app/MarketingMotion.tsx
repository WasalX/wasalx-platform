"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MarketingIcon } from "./MarketingIcon";
import { rememberBoundaryTheme, type BoundaryTheme } from "./boundary-preferences";

const MotionContext = createContext({ enabled: false, paused: false, toggle: () => {}, theme: "light" as BoundaryTheme, toggleTheme: () => {} });

export function MarketingMotion({ children, initialTheme }: { children: ReactNode; initialTheme: BoundaryTheme }) {
  const [enabled, setEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [theme, setTheme] = useState(initialTheme);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    rememberBoundaryTheme("tenant", next);
  };
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnabled(!preference.matches && !document.hidden);
    update();
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.toggleAttribute("data-visible", entry.isIntersecting);
    }, { threshold: 0.15 });
    root.current?.querySelectorAll("[data-motion-scene]").forEach(scene => observer.observe(scene));
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      observer.disconnect();
    };
  }, []);
  return <MotionContext.Provider value={{ enabled, paused, toggle: () => setPaused(value => !value), theme, toggleTheme }}>
    <meta name="color-scheme" content={theme}/>
    <div className={`marketing-shell theme-${theme}`} ref={root} data-motion={enabled && !paused ? "on" : "off"}>{children}</div>
  </MotionContext.Provider>;
}

export function MarketingThemeToggle({ light, dark }: { light: string; dark: string }) {
  const { theme, toggleTheme } = useContext(MotionContext);
  const label = theme === "dark" ? light : dark;
  return <button type="button" className="marketing-theme-toggle" onClick={toggleTheme} aria-label={label} title={label}>
    <MarketingIcon name={theme === "dark" ? "sun" : "moon"}/>
  </button>;
}

export function useMarketingMotion<T extends HTMLElement>() {
  const { enabled, paused } = useContext(MotionContext);
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, running: enabled && !paused && visible, enabled };
}

export function MarketingMotionToggle({ pause, play }: { pause: string; play: string }) {
  const { paused, toggle } = useContext(MotionContext);
  return <button type="button" className="marketing-motion-toggle" onClick={toggle} aria-pressed={paused} aria-label={paused ? play : pause} title={paused ? play : pause}>
    <MarketingIcon name={paused ? "play" : "pause"}/><span>{paused ? play : pause}</span>
  </button>;
}

export function MarketingHeadline({ title, ending, words, soon }: { title: string; ending: string; words: { text: string; whatsapp?: boolean; upcoming?: boolean }[]; soon: string }) {
  const { ref, running, enabled } = useMarketingMotion<HTMLHeadingElement>();
  const [typing, setTyping] = useState({ word: 0, length: words[0].text.length, deleting: false });
  useEffect(() => {
    if (!running) return;
    const word = words[typing.word].text;
    const timer = window.setTimeout(() => {
      setTyping(current => {
        if (!current.deleting && current.length === word.length) return { ...current, deleting: true };
        if (current.deleting && current.length === 0) return { word: (current.word + 1) % words.length, length: 0, deleting: false };
        return { ...current, length: current.length + (current.deleting ? -1 : 1) };
      });
    }, !typing.deleting && typing.length === word.length ? 2200 : typing.deleting ? 35 : 75);
    return () => window.clearTimeout(timer);
  }, [running, typing, words]);
  const active = words[typing.word];
  return <h1 id="marketing-title" ref={ref}>
    <span className="wx-visually-hidden">{title} {ending}</span>
    <span className="marketing-type-line" aria-hidden="true">
      <span className="marketing-type-reserve">{title}</span>
      <span className="marketing-type-text" data-whatsapp={enabled && !!active.whatsapp}>{enabled ? active.text.slice(0, typing.length) : title}<span className="marketing-caret" data-running={running}/></span>
      <span className="marketing-type-soon" data-shown={enabled && !!active.upcoming}>{soon}</span>
    </span>
    <span className="marketing-title-end" aria-hidden="true">{ending}</span>
  </h1>;
}
