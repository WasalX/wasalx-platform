"use client";

import { Inbox } from "./Inbox";
import { GroupInbox } from "./GroupInbox";
import { useI18n } from "./I18nProvider";

export function InboxWorkspace({ mode, selectedGroup, selectedMessage = null, selectedTicket, selectGroup, selectTicket, selectMode,
  mutationHeaders, canWrite, scope, recoveryScope, owner = false }: {
  mode: "tickets" | "groups"; selectedGroup: string | null; selectedTicket: string | null;
  selectedMessage?: string | null; selectGroup: (id: string | null, messageId?: string) => void; selectTicket: (number: string | null) => void;
  selectMode: (mode: "tickets" | "groups") => void; mutationHeaders: Record<string, string>;
  canWrite: boolean; scope: string; recoveryScope: string; owner?: boolean;
}) {
  const { t } = useI18n();
  return <section aria-label={t("inbox.title")}>
    <nav className="wx-inbox-switch" aria-label={t("inbox.workspace")}>
      <button type="button" className="wx-button" aria-pressed={mode === "tickets"} onClick={() => selectMode("tickets")}>{t("inbox.conversations")}</button>
      <button type="button" className="wx-button" aria-pressed={mode === "groups"} onClick={() => selectMode("groups")}>{t("inbox.groupConversations")}</button>
    </nav>
    <div hidden={mode !== "tickets"}>
      <Inbox mutationHeaders={mutationHeaders} targetTicketNumber={selectedTicket} selectTicket={selectTicket}
        canWrite={canWrite} scope={scope} recoveryScope={recoveryScope} active={mode === "tickets"} isOwner={owner}
        selectSource={source => selectGroup(source.group_id, source.message_id)} />
    </div>
    <div hidden={mode !== "groups"}>
      <GroupInbox selectedGroup={selectedGroup} selectedMessage={selectedMessage} selectGroup={selectGroup} selectTicket={number => selectTicket(number)}
        mutationHeaders={mutationHeaders} canWrite={canWrite} scope={scope} recoveryScope={recoveryScope} active={mode === "groups"} />
    </div>
  </section>;
}
