"use client";

import { useRef } from "react";
import { useI18n } from "./I18nProvider";

export function AttachmentFilePicker({ id, accept, disabled, empty, onSelect }: {
  id: string;
  accept?: string;
  disabled: boolean;
  empty: boolean;
  onSelect: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const emptyId = empty ? id + "-empty" : undefined;
  return <div className="wx-attachment-picker">
    <input ref={input} id={id} type="file" hidden multiple disabled={disabled} accept={accept} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length) onSelect(files);
    }} />
    <button type="button" className="wx-button" disabled={disabled} aria-describedby={emptyId}
      onClick={() => input.current?.click()}>{t("attachments.choose")}</button>
    {empty ? <span id={emptyId}>{t("attachments.none")}</span> : null}
  </div>;
}
