"use client";

import { lazy, Suspense, useCallback, useState, type ComponentProps } from "react";
import { useI18n } from "./I18nProvider";
import { SectionLoading } from "./tenant-ui";
import styles from "./MetaCostUsage.module.css";

const MetaCostUsage = lazy(async () => ({ default: (await import("./MetaCostUsage")).MetaCostUsage }));

export function MetaCostDisclosure(props: Omit<ComponentProps<typeof MetaCostUsage>, "open">) {
  const { t } = useI18n();
  const [open, setOpen] = useState(Boolean(props.platform));
  const syncOpen = useCallback((details: HTMLDetailsElement | null) => {
    if (details) setOpen(details.open);
  }, []);

  // The native focus target survives hydration of the lazy panel.
  return (
    <details ref={syncOpen} className={styles.section} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t("cost.title")}</summary>
      <Suspense fallback={<SectionLoading />}>
        <MetaCostUsage {...props} open={open} />
      </Suspense>
    </details>
  );
}
