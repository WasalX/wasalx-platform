"use client";
import type { NativeAccountObservation } from "../lib/control-plane-data";
import { nativeAccountObservationState } from "../lib/native-account-observation";
import { formatDateTime } from "../lib/i18n/format";
import { useI18n } from "./I18nProvider";

export function NativeAccountStatus({ observation, expected, unavailable = false }: {
  observation?: NativeAccountObservation;
  expected?: { revision: string | number; nativeUserId: string | null };
  unavailable?: boolean;
}) {
  const { locale, t } = useI18n();
  const state = unavailable ? "UNAVAILABLE" : nativeAccountObservationState(observation, expected);
  const warning = state === "DRIFT" || state === "UNAVAILABLE";
  return <small className={warning ? "danger-text" : "team-protected"} data-native-observation={state}>
    <span>{warning ? <span aria-hidden="true">! </span> : null}{t(`tenant.workspaceAccess.observation.${state}`)}</span>
    {(state === "VERIFIED" || state === "DRIFT") && observation?.checkedAt ? <><br /><time dateTime={observation.checkedAt}>{t("tenant.workspaceAccess.observation.checked", { time: formatDateTime(observation.checkedAt, locale) })}</time></> : null}
  </small>;
}
