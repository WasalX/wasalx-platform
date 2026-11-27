"use client";
import { createReplaceableRequestController } from "../lib/meta-capability-request";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { MarketingIcon } from "./MarketingIcon";
import { formatNumber } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure, confirmUnsavedNavigation, createLatestRequestFence } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { RelativeTime, exactTime, type TenantTranslator, apiError, requiresPrivilegedReauthentication, privilegedStepUpHref, Status, Empty, WideTable } from "./tenant-ui";

type WorkspaceSettings = {
  id: string;
  name: string;
  slug: string;
  accent_color: string;
  default_theme: "LIGHT" | "DARK" | "SYSTEM";
  group_disclosure_enabled: boolean;
  group_disclosure_message: string;
  sso_enforcement_state: "DISABLED" | "REQUESTED" | "ACTIVE";
  sso_provider_name: string | null;
  sso_issuer: string | null;
  sso_email_domains: string[];
  mfa_required_roles: string[];
  session_timeout_minutes: number;
  privileged_reauth_minutes: number;
  support_access_requires_approval: boolean;
  security_policy_state: "REQUESTED" | "ACTIVE";
  policy_verified_at: string | null;
  version: number;
  updated_at: string;
};

type SettingsSection = "general" | "identity" | "security" | "groupHistory" | "privacy";
const SETTINGS_SECTION_STORAGE_KEY = "wasalx:settings-section";

type WorkspaceForm = {
  name: string;
  slug: string;
  accentColor: string;
  defaultTheme: "LIGHT" | "DARK" | "SYSTEM";
  groupDisclosureEnabled: boolean;
  groupDisclosureMessage: string;
  ssoEnforcementRequested: boolean;
  ssoProviderName: string;
  ssoIssuer: string;
  ssoEmailDomains: string;
  mfaRequiredRoles: string[];
  sessionTimeoutMinutes: string;
  privilegedReauthMinutes: string;
  supportAccessRequiresApproval: boolean;
};

function workspaceForm(settings: WorkspaceSettings): WorkspaceForm {
  return {
    name: settings.name,
    slug: settings.slug,
    accentColor: settings.accent_color,
    defaultTheme: settings.default_theme,
    groupDisclosureEnabled: settings.group_disclosure_enabled,
    groupDisclosureMessage: settings.group_disclosure_message,
    ssoEnforcementRequested: settings.sso_enforcement_state !== "DISABLED",
    ssoProviderName: settings.sso_provider_name ?? "",
    ssoIssuer: settings.sso_issuer ?? "",
    ssoEmailDomains: settings.sso_email_domains.join(", "),
    mfaRequiredRoles: settings.mfa_required_roles,
    sessionTimeoutMinutes: String(settings.session_timeout_minutes),
    privilegedReauthMinutes: String(settings.privileged_reauth_minutes),
    supportAccessRequiresApproval: settings.support_access_requires_approval,
  };
}

type GroupWorkspaceDefaults={group_workspace_enabled:boolean;group_history_default_retention_days:number;group_history_default_visibility:"RESTRICTED"|"ALL_AGENTS";version:number};
function GroupHistoryDefaults({editable,mutationHeaders}:{editable:boolean;mutationHeaders:Record<string,string>}){
  const{locale,t}=useI18n();const[settings,setSettings]=useState<GroupWorkspaceDefaults|null>(null);const[form,setForm]=useState<{enabled:boolean;retentionDays:string;visibility:"RESTRICTED"|"ALL_AGENTS"}|null>(null);const[saved,setSaved]=useState<typeof form>(null);const[loading,setLoading]=useState(true);const[saving,setSaving]=useState(false);const[error,setError]=useState<string|null>(null);const[notice,setNotice]=useState<string|null>(null);const saveKey=useRef<string|null>(null);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{if(!background)setLoading(true);setError(null);try{const response=await fetch("/api/group-workspace/settings",{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as GroupWorkspaceDefaults;const nextForm={enabled:next.group_workspace_enabled,retentionDays:String(next.group_history_default_retention_days),visibility:next.group_history_default_visibility};setSettings(next);setForm(nextForm);setSaved(nextForm)}catch(loadError){if(loadError instanceof DOMException&&loadError.name==="AbortError")return;setError(operatorFailureMessage(loadError, t("tenant.settings.groupHistory.errors.load")))}finally{if(!background)setLoading(false)}},[t]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);const dirty=Boolean(form&&saved&&JSON.stringify(form)!==JSON.stringify(saved));useVisibleRefresh(signal=>load(true,signal),!dirty&&!saving);
  const retentionInvalid=Boolean(form&&(!Number.isInteger(Number(form.retentionDays))||Number(form.retentionDays)<1||Number(form.retentionDays)>3650));
  const update=<K extends keyof NonNullable<typeof form>>(key:K,value:NonNullable<typeof form>[K])=>{setForm(current=>current?{...current,[key]:value}:current);setError(null);setNotice(null)};
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!settings||!form||!editable||saving||retentionInvalid)return;setSaving(true);setError(null);setNotice(null);try{const idempotencyKey=saveKey.current??crypto.randomUUID();saveKey.current=idempotencyKey;const response=await fetch("/api/group-workspace/settings",{method:"PUT",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({...form,retentionDays:Number(form.retentionDays),expectedVersion:settings.version})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as GroupWorkspaceDefaults;saveKey.current=null;const nextForm={enabled:next.group_workspace_enabled,retentionDays:String(next.group_history_default_retention_days),visibility:next.group_history_default_visibility};setSettings(next);setForm(nextForm);setSaved(nextForm);setNotice(t("tenant.settings.groupHistory.saved"))}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.settings.groupHistory.errors.save")))}finally{setSaving(false)}};
  if(loading)return <section className="panel settings-skeleton" role="status">{t("tenant.settings.groupHistory.loading")}</section>;
  if(!settings||!form)return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.settings.groupHistory.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("common.actions.retry")}</button></div></section>;
  return <form className="panel settings-form" data-unsaved={dirty||undefined} onSubmit={save}><div className="panel-heading settings-heading"><div><h2>{t("tenant.settings.groupHistory.title")}</h2><p>{t("tenant.settings.groupHistory.body")}</p></div><span className="settings-version mono"><bdi>v{formatNumber(settings.version,locale,{useGrouping:false})}</bdi></span></div>{!editable?<div className="settings-readonly"><span>i</span><p><b>{t("tenant.settings.readOnly.title")}</b><small>{t("tenant.settings.groupHistory.ownerOnly")}</small></p></div>:null}<div className="settings-fields"><div className="setting-row settings-toggle-row"><span><b>{t("tenant.settings.groupHistory.enableTitle")}</b><small>{t("tenant.settings.groupHistory.enableBody")}</small></span><button type="button" className={`switch ${form.enabled?"on":""}`} aria-pressed={form.enabled} aria-label={t("tenant.settings.groupHistory.enableToggle")} disabled={!editable} onClick={()=>update("enabled",!form.enabled)}><span/></button></div><label htmlFor="group-history-default-retention">{t("tenant.settings.groupHistory.retention")}<input id="group-history-default-retention" type="number" min="1" max="3650" value={form.retentionDays} readOnly={!editable} aria-invalid={retentionInvalid||undefined} aria-describedby="group-history-default-retention-help" onChange={event=>update("retentionDays",event.target.value)}/><small id="group-history-default-retention-help">{retentionInvalid?t("tenant.group.configuration.blockers.retention",{min:formatNumber(1,locale),max:formatNumber(3650,locale)}):t("tenant.settings.groupHistory.retentionHelp")}</small></label><label htmlFor="group-history-default-visibility">{t("tenant.settings.groupHistory.visibility")}<select id="group-history-default-visibility" value={form.visibility} disabled={!editable} onChange={event=>update("visibility",event.target.value as NonNullable<typeof form>["visibility"])}><option value="RESTRICTED">{t("tenant.group.history.visibilityRestricted")}</option><option value="ALL_AGENTS">{t("tenant.group.history.visibilityAll")}</option></select><small>{t("tenant.settings.groupHistory.visibilityHelp")}</small></label><div className="settings-secret-boundary settings-wide"><span>i</span><p><b>{t("tenant.settings.groupHistory.noBackfillTitle")}</b><small>{t("tenant.settings.groupHistory.noBackfillBody")}</small></p></div></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p></div>:null}{notice?<div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div>:null}<div className="save-bar"><span>{dirty?t("tenant.settings.state.unsaved"):t("tenant.settings.state.saved")}</span><div>{dirty?<button type="button" className="button secondary" onClick={()=>setForm(saved)}>{t("tenant.settings.actions.discard")}</button>:null}<button className="button primary" disabled={!editable||!dirty||saving||retentionInvalid}>{t(saving?"tenant.settings.actions.saving":"tenant.settings.actions.save")}</button></div></div></form>;
}

export function Settings({
  recoveryScope,
  editable,
  role,
  isPrivateDemo,
  isFixturePreview,
  mutationHeaders,
}: {
  recoveryScope: string;
  editable: boolean;
  role: string;
  isPrivateDemo: boolean;
  isFixturePreview: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { locale, t } = useI18n();
  const canReadPrivacy = role === "tenant_owner" || role === "tenant_admin" || role === "auditor";
  const [section, setSection] = useState<SettingsSection>(isPrivateDemo ? "privacy" : "general");
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [form, setForm] = useState<WorkspaceForm | null>(null);
  const [savedForm, setSavedForm] = useState<WorkspaceForm | null>(null);
  const [loading, setLoading] = useState(!isPrivateDemo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settingsNav = useRef<HTMLDivElement>(null);
  const settingsSections: SettingsSection[] = canReadPrivacy
    ? ["general","identity","security","groupHistory","privacy"]
    : ["general","identity","security","groupHistory"];
  const settingsPanelId = "settings-panel";
  useEffect(() => {
    if (isPrivateDemo) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = window.sessionStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
        const allowed = stored === "general" || stored === "identity" || stored === "security" || stored === "groupHistory" || stored === "privacy";
        setSection(allowed && (stored !== "privacy" || canReadPrivacy) ? stored : "general");
      } catch { /* Storage is optional; the safe default remains General. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canReadPrivacy, isPrivateDemo]);
  const selectSection = (next: typeof section) => {
    if (section === next) return true;
    if (!confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) return false;
    if (dirty) {
      setForm(savedForm);
      setError(null);
      setNotice(null);
    }
    try { window.sessionStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, next); } catch { /* Navigation still works when storage is unavailable. */ }
    setSection(next);
    return true;
  };
  useLayoutEffect(()=>{if(!loading)settingsNav.current?.querySelector<HTMLElement>(`#settings-tab-${section}`)?.scrollIntoView({block:"nearest",inline:"nearest"})},[loading,section]);
  const moveSettingsTab=(event:React.KeyboardEvent<HTMLElement>)=>{
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
    event.preventDefault();
    const current=Math.max(0,settingsSections.indexOf(section));
    const index=event.key==="Home"?0:event.key==="End"?settingsSections.length-1:(current+(["ArrowRight","ArrowDown"].includes(event.key)?1:-1)+settingsSections.length)%settingsSections.length;
    const next=settingsSections[index]!;
    if(selectSection(next))window.requestAnimationFrame(()=>document.getElementById(`settings-tab-${next}`)?.focus());
  };

  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    if (isPrivateDemo) return;
    if (!background) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", { cache: "no-store", signal });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as WorkspaceSettings;
      const nextForm = workspaceForm(next);
      setSettings(next);
      setForm(nextForm);
      setSavedForm(nextForm);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(operatorFailureMessage(loadError, t("tenant.settings.errors.load")));
    } finally { if (!background) setLoading(false); }
  }, [isPrivateDemo, t]);

  useEffect(() => { if (isPrivateDemo) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [isPrivateDemo, load]);
  const dirty = Boolean(form && savedForm && JSON.stringify(form) !== JSON.stringify(savedForm));
  useVisibleRefresh((signal) => load(true, signal), !isPrivateDemo && !dirty && !saving);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = <K extends keyof WorkspaceForm>(key: K, value: WorkspaceForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setError(null);
    setNotice(null);
  };
  const blockers: string[] = [];
  if (form) {
    if (form.name.trim().length < 2) blockers.push(t("tenant.settings.validation.name"));
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(form.slug) || form.slug.includes("--")) blockers.push(t("tenant.settings.validation.slug"));
    if (!/^#[0-9a-f]{6}$/iu.test(form.accentColor)) blockers.push(t("tenant.settings.validation.accent"));
    if (!form.groupDisclosureMessage.trim()) blockers.push(t("tenant.settings.validation.disclosure"));
    if (form.ssoEnforcementRequested && (!form.ssoProviderName.trim() || !form.ssoIssuer.trim() || !form.ssoEmailDomains.trim())) blockers.push(t("tenant.settings.validation.sso"));
    if (!form.mfaRequiredRoles.includes("tenant_owner")) blockers.push(t("tenant.settings.validation.ownerMfa"));
    const sessionMinutes = Number(form.sessionTimeoutMinutes);
    if (!Number.isInteger(sessionMinutes) || sessionMinutes < 15 || sessionMinutes > 1440) blockers.push(t("tenant.settings.validation.session"));
    const reauthMinutes = Number(form.privilegedReauthMinutes);
    if (!Number.isInteger(reauthMinutes) || reauthMinutes < 5 || reauthMinutes > 120) blockers.push(t("tenant.settings.validation.reauth"));
  }

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || !settings || !editable || blockers.length || saving) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({
          expectedVersion: settings.version,
          ...form,
          name: form.name.trim(), slug: form.slug.trim().toLowerCase(), accentColor: form.accentColor.toUpperCase(),
          ssoProviderName: form.ssoProviderName.trim() || null,
          ssoIssuer: form.ssoIssuer.trim() || null,
          ssoEmailDomains: form.ssoEmailDomains.split(",").map((domain) => domain.trim()).filter(Boolean),
          sessionTimeoutMinutes: Number(form.sessionTimeoutMinutes),
          privilegedReauthMinutes: Number(form.privilegedReauthMinutes),
        }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const updated = await response.json() as WorkspaceSettings;
      const nextForm = workspaceForm(updated);
      setSettings(updated); setForm(nextForm); setSavedForm(nextForm);
      setNotice(t("tenant.settings.notice.saved"));
    } catch (saveError) {
      setError(operatorFailureMessage(saveError, t("tenant.settings.errors.save")));
    } finally { setSaving(false); }
  };

  if (isPrivateDemo) return <div className="settings-grid settings-grid-privacy"><div className="panel settings-nav" role="tablist" aria-label={t("tenant.settings.sections.label")}><button id="settings-tab-privacy" type="button" role="tab" aria-selected="true" aria-controls={settingsPanelId} className="active">{t("tenant.settings.sections.privacy")}</button></div><div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-privacy"><PrivacySettings recoveryScope={recoveryScope} role={role} isPrivateDemo isFixturePreview={false} mutationHeaders={mutationHeaders}/></div></div>;
  if (loading) return <SettingsSkeleton />;
  if (!settings || !form) {
    return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.settings.errors.unavailable")}</b><p>{error ?? t("tenant.settings.errors.empty")}</p><button className="button small" onClick={() => void load()}>{t("tenant.settings.actions.tryAgain")}</button></div></section>;
  }
  return (
    <div className={`settings-grid ${section === "privacy" ? "settings-grid-privacy" : ""}`}>
      <div ref={settingsNav} className="panel settings-nav" role="tablist" aria-label={t("tenant.settings.sections.label")}>
        {settingsSections.map(item=><button key={item} id={`settings-tab-${item}`} type="button" role="tab" aria-selected={section===item} aria-controls={settingsPanelId} tabIndex={section===item?0:-1} className={section===item?"active":""} onKeyDown={moveSettingsTab} onClick={()=>{if(!selectSection(item))window.requestAnimationFrame(()=>document.getElementById(`settings-tab-${section}`)?.focus())}}>{t(`tenant.settings.sections.${item}`)}</button>)}
      </div>
      {section === "privacy" && canReadPrivacy ? <div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-privacy"><PrivacySettings recoveryScope={recoveryScope} role={role} isPrivateDemo={isPrivateDemo} isFixturePreview={isFixturePreview} mutationHeaders={mutationHeaders} /></div> : section === "groupHistory" ? <div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-groupHistory"><GroupHistoryDefaults editable={editable} mutationHeaders={mutationHeaders}/></div> : <form id={settingsPanelId} role="tabpanel" aria-labelledby={`settings-tab-${section}`} className="panel settings-form" data-unsaved={dirty||undefined} onSubmit={save}>
        <div className="panel-heading settings-heading">
          <div>
            <h2>{t(`tenant.settings.heading.${section}`)}</h2>
            <p>{t(`tenant.settings.description.${section}`)}</p>
          </div>
          <span className="settings-version mono"><bdi>v{formatNumber(settings.version, locale, { useGrouping: false })}</bdi></span>
        </div>
        {!editable ? <div className="settings-readonly"><span>◉</span><p><b>{t("tenant.settings.readOnly.title")}</b><small>{t("tenant.settings.readOnly.body")}</small></p></div> : null}
        {section === "general" ? (
          <div className="settings-fields">
            <label htmlFor="workspace-name">{t("tenant.settings.general.name")}<input id="workspace-name" dir="auto" value={form.name} maxLength={100} readOnly={!editable} onChange={(event) => update("name", event.target.value)} /></label>
            <label htmlFor="workspace-slug">{t("tenant.settings.general.slug")}<div className="input-prefix" dir="ltr"><span><bdi>{t("tenant.settings.general.slugPrefix")}</bdi></span><input id="workspace-slug" dir="ltr" value={form.slug} maxLength={48} readOnly={!editable} onChange={(event) => update("slug", event.target.value.toLowerCase())} /></div></label>
            <label htmlFor="workspace-accent">{t("tenant.settings.general.accent")}<div className="color-input"><i style={{ backgroundColor: /^#[0-9a-f]{6}$/iu.test(form.accentColor) ? form.accentColor : "transparent" }} /><input id="workspace-accent" dir="ltr" value={form.accentColor} maxLength={7} readOnly={!editable} spellCheck={false} onChange={(event) => update("accentColor", event.target.value)} /></div></label>
            <label htmlFor="workspace-theme">{t("tenant.settings.general.theme")}<select id="workspace-theme" value={form.defaultTheme} disabled={!editable} onChange={(event) => update("defaultTheme", event.target.value as WorkspaceForm["defaultTheme"])}><option value="SYSTEM">{t("tenant.settings.general.themeSystem")}</option><option value="DARK">{t("tenant.settings.general.themeDark")}</option><option value="LIGHT">{t("tenant.settings.general.themeLight")}</option></select></label>
            <div className="setting-row settings-toggle-row"><span><b>{t("tenant.settings.general.disclosureTitle")}</b><small>{t("tenant.settings.general.disclosureBody")}</small></span><button type="button" className={`switch ${form.groupDisclosureEnabled ? "on" : ""}`} aria-pressed={form.groupDisclosureEnabled} aria-label={t("tenant.settings.general.disclosureToggle")} disabled={!editable} onClick={() => update("groupDisclosureEnabled", !form.groupDisclosureEnabled)}><span /></button></div>
            <label htmlFor="workspace-disclosure" className="settings-wide">{t("tenant.settings.general.disclosureMessage")}<textarea id="workspace-disclosure" dir="auto" value={form.groupDisclosureMessage} maxLength={500} readOnly={!editable} rows={4} onChange={(event) => update("groupDisclosureMessage", event.target.value)} /><small>{t("tenant.settings.general.disclosureHelp", { count: formatNumber(form.groupDisclosureMessage.length, locale), max: formatNumber(500, locale) })}</small></label>
          </div>
        ) : section === "identity" ? (
          <div className="settings-fields">
            <div className="setting-row settings-toggle-row settings-wide"><span><b>{t("tenant.settings.identity.enforceTitle")}</b><small>{t(settings.sso_enforcement_state === "ACTIVE" ? "tenant.settings.identity.enforceActive" : "tenant.settings.identity.enforcePending")}</small></span><button type="button" className={`switch ${form.ssoEnforcementRequested ? "on" : ""}`} aria-pressed={form.ssoEnforcementRequested} aria-label={t("tenant.settings.identity.enforceToggle")} disabled={!editable} onClick={() => update("ssoEnforcementRequested", !form.ssoEnforcementRequested)}><span /></button></div>
            <label htmlFor="sso-provider">{t("tenant.settings.identity.provider")}<input id="sso-provider" dir="auto" value={form.ssoProviderName} maxLength={100} readOnly={!editable} placeholder={t("tenant.settings.identity.providerPlaceholder")} onChange={(event) => update("ssoProviderName", event.target.value)} /></label>
            <label htmlFor="sso-issuer">{t("tenant.settings.identity.issuer")}<input id="sso-issuer" dir="ltr" value={form.ssoIssuer} maxLength={500} readOnly={!editable} inputMode="url" placeholder={t("tenant.settings.identity.issuerPlaceholder")} onChange={(event) => update("ssoIssuer", event.target.value)} /></label>
            <label htmlFor="sso-domains" className="settings-wide">{t("tenant.settings.identity.domains")}<input id="sso-domains" dir="ltr" value={form.ssoEmailDomains} readOnly={!editable} placeholder={t("tenant.settings.identity.domainsPlaceholder")} onChange={(event) => update("ssoEmailDomains", event.target.value)} /><small>{t("tenant.settings.identity.domainsHelp")}</small></label>
            <div className="settings-secret-boundary settings-wide"><span>⌁</span><p><b>{t("tenant.settings.identity.metadataTitle")}</b><small>{t("tenant.settings.identity.metadataBody")}</small></p></div>
          </div>
        ) : (
          <div className="settings-fields">
            <div className="settings-secret-boundary settings-wide"><span>{settings.security_policy_state === "ACTIVE" ? "✓" : "…"}</span><p><b>{t(settings.security_policy_state === "ACTIVE" ? "tenant.settings.security.activeTitle" : "tenant.settings.security.pendingTitle")}</b><small>{settings.security_policy_state === "ACTIVE" ? <>{t("tenant.settings.security.verified")} <RelativeTime value={settings.policy_verified_at} pastOnly/>. {t("tenant.settings.security.enforced")}</> : t("tenant.settings.security.pendingBody")}</small></p></div>
            <fieldset className="settings-role-grid settings-wide"><legend>{t("tenant.settings.security.mfaRoles")}</legend>{(["tenant_owner","tenant_admin","supervisor","agent","auditor"] as const).map((role) => <label key={role}><input type="checkbox" checked={form.mfaRequiredRoles.includes(role)} disabled={!editable || role === "tenant_owner"} onChange={(event) => update("mfaRequiredRoles", event.target.checked ? [...form.mfaRequiredRoles, role] : form.mfaRequiredRoles.filter((item) => item !== role))} />{t(`tenant.role.${role}`)}</label>)}</fieldset>
            <label htmlFor="session-timeout">{t("tenant.settings.security.sessionTimeout")}<input id="session-timeout" type="number" min={15} max={1440} value={form.sessionTimeoutMinutes} readOnly={!editable} onChange={(event) => update("sessionTimeoutMinutes", event.target.value)} /></label>
            <label htmlFor="reauth-timeout">{t("tenant.settings.security.reauthTimeout")}<input id="reauth-timeout" type="number" min={5} max={120} value={form.privilegedReauthMinutes} readOnly={!editable} onChange={(event) => update("privilegedReauthMinutes", event.target.value)} /></label>
            <div className="setting-row settings-toggle-row settings-wide"><span><b>{t("tenant.settings.security.supportApprovalTitle")}</b><small>{t("tenant.settings.security.supportApprovalBody")}</small></span><Status value="active" /></div>
          </div>
        )}
        {error ? <div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p><button type="button" className="button small" onClick={() => { if (confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) void load(); }}>{t("tenant.settings.actions.reload")}</button></div> : null}
        {notice ? <div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div> : null}
        {blockers.length ? <div className="settings-validation" role="status"><b>{t("tenant.settings.validation.title")}</b><ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        <div className="save-bar"><span>{dirty ? t("tenant.settings.state.unsaved") : <>{t("tenant.settings.state.saved")} <RelativeTime value={settings.updated_at} pastOnly/></>}{!editable ? ` · ${t("tenant.settings.state.ownerRequired")}` : ""}</span><div>{dirty ? <button type="button" className="button secondary" onClick={() => { setForm(savedForm); setError(null); setNotice(null); }}>{t("tenant.settings.actions.discard")}</button> : null}<button className="button primary" type="submit" disabled={!editable || !dirty || blockers.length > 0 || saving}>{saving ? t("tenant.settings.actions.saving") : t("tenant.settings.actions.save")}</button></div></div>
      </form>}
    </div>
  );
}

function SettingsSkeleton() {
  const { t } = useI18n();
  return <div className="settings-grid" aria-busy="true"><p className="sr-only" role="status" aria-label={t("tenant.settings.loading")}>{t("tenant.settings.loading")}</p><section aria-hidden="true" className="panel settings-nav settings-skeleton-nav"><span /><span /><span /></section><section aria-hidden="true" className="panel settings-skeleton"><span className="group-skeleton group-skeleton-title" /><span className="group-skeleton" /><span className="group-skeleton" /><span className="group-skeleton" /></section></div>;
}

type PrivacyPolicy = {
  state: "ACTIVE" | "PAUSED"; resolved_case_days: number; include_open_cases: boolean;
  media_days: number; unmatched_diagnostic_hours: number; export_ttl_hours: number;
  next_sweep_at: string; version: number; updated_at: string; zammad_privacy_configured: boolean;
};
type PrivacyHold = {
  id: string; scope_type: string; scope_value: string | null; scope_sha256: string;
  reason: string; state: string; expires_at: string | null; created_at: string; updated_at: string;
};
type PrivacyRequest = {
  id: string; request_type: "EXPORT" | "DELETE"; scope_type: string; scope_value: string | null;
  scope_sha256: string; disposition: string; state: string; error_code: string | null;
  safe_error: string | null; completed_at: string | null; created_at: string; updated_at: string;
  stage?: string; attempts?: number; max_attempts?: number; summary?: Record<string, unknown>;
  artifact_id: string | null; artifact_byte_size: number | null; artifact_expires_at: string | null;
};
type PrivacyPolicyForm = {
  state: "ACTIVE" | "PAUSED"; resolvedCaseDays: string; includeOpenCases: boolean;
  mediaDays: string; unmatchedDiagnosticHours: string; exportTtlHours: string;
};

function privacyPolicyForm(policy: PrivacyPolicy): PrivacyPolicyForm {
  return { state: policy.state, resolvedCaseDays: String(policy.resolved_case_days), includeOpenCases: policy.include_open_cases, mediaDays: String(policy.media_days), unmatchedDiagnosticHours: String(policy.unmatched_diagnostic_hours), exportTtlHours: String(policy.export_ttl_hours) };
}

function PrivacySettings({ recoveryScope, role, isPrivateDemo, isFixturePreview, mutationHeaders }: { recoveryScope: string; role: string; isPrivateDemo: boolean; isFixturePreview: boolean; mutationHeaders: Record<string,string> }) {
  const {locale,t}=useI18n();
  const [policy,setPolicy]=useState<PrivacyPolicy|null>(null);const [policyForm,setPolicyForm]=useState<PrivacyPolicyForm|null>(null);const [savedPolicyForm,setSavedPolicyForm]=useState<PrivacyPolicyForm|null>(null);
  const [holds,setHolds]=useState<PrivacyHold[]>([]);const [requests,setRequests]=useState<PrivacyRequest[]>([]);const [loading,setLoading]=useState(!isPrivateDemo);const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);const [busy,setBusy]=useState<string|null>(null);
  const [holdOpen,setHoldOpen]=useState(false);const [requestType,setRequestType]=useState<"EXPORT"|"DELETE"|null>(null);const [releaseHold,setReleaseHold]=useState<PrivacyHold|null>(null);const [retryRequest,setRetryRequest]=useState<PrivacyRequest|null>(null);const [detailId,setDetailId]=useState<string|null>(null);
  const [download,setDownload]=useState<{requestId:string;url:string;expiresIn:number}|null>(null);
  const canManagePolicy=role==="tenant_owner";const canManageHolds=role==="tenant_owner";const canExport=role==="tenant_owner"||role==="tenant_admin";const canDelete=role==="tenant_owner";
  const privacyLoadFence=useRef(createLatestRequestFence());
  const privacyLifetime=useRef({mounted:false});
  const dirty=Boolean(policyForm&&savedPolicyForm&&JSON.stringify(policyForm)!==JSON.stringify(savedPolicyForm));
  const privacyDirty=useRef(dirty);
  useLayoutEffect(()=>{privacyDirty.current=dirty},[dirty]);
  useEffect(()=>{const state=privacyLifetime.current,fence=privacyLoadFence.current;state.mounted=true;return()=>{state.mounted=false;fence.invalidate()}},[]);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{
    if(isPrivateDemo)return;
    const execution=privacyLoadFence.current.begin();
    const current=()=>privacyLifetime.current.mounted&&!signal?.aborted&&privacyLoadFence.current.isCurrent(execution);
    if(!background)setLoading(true);setError(null);
    try{
      const responses=await Promise.all([fetch("/api/privacy/policy",{cache:"no-store",signal}),fetch("/api/privacy/holds",{cache:"no-store",signal}),fetch("/api/privacy/requests",{cache:"no-store",signal})]);
      if(!current())return;
      for(const response of responses)if(!response.ok)throw Object.assign(operatorLocalFailure(await apiError(response)),{status:response.status});
      const [nextPolicy,nextHolds,nextRequests]=await Promise.all(responses.map(response=>response.json())) as [PrivacyPolicy,PrivacyHold[],PrivacyRequest[]];
      if(!current())return;
      if(!privacyDirty.current){const nextForm=privacyPolicyForm(nextPolicy);setPolicy(nextPolicy);setPolicyForm(nextForm);setSavedPolicyForm(nextForm);}
      setHolds(nextHolds);setRequests(nextRequests);
    }catch(cause){
      if(!current()||isAbortError(cause))return;
      if([401,403].includes((cause as {status?:number}).status??0)){
        privacyLoadFence.current.invalidate();setPolicy(null);setPolicyForm(null);setSavedPolicyForm(null);setHolds([]);setRequests([]);
        setHoldOpen(false);setRequestType(null);setReleaseHold(null);setRetryRequest(null);setDetailId(null);setDownload(null);setBusy(null);setLoading(false);
      }
      setError(operatorFailureMessage(cause, t("tenant.privacy.error.load")));
    }finally{if(current())setLoading(false);}
  },[isPrivateDemo,t]);
  useEffect(()=>{if(isPrivateDemo)return;const controller=new AbortController();const timer=window.setTimeout(()=>void load(false,controller.signal),0);return()=>{window.clearTimeout(timer);controller.abort()}},[isPrivateDemo,load]);
  useVisibleRefresh(signal=>load(true,signal),!isPrivateDemo&&!dirty&&busy===null&&!holdOpen&&!requestType&&!releaseHold&&!retryRequest&&!detailId);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn)},[dirty]);
  if(isPrivateDemo)return <section className="panel privacy-demo-state" aria-labelledby="privacy-demo-heading"><div className="panel-heading"><div><h2 id="privacy-demo-heading">{t("tenant.privacy.demo.title")}</h2><p>{t("tenant.privacy.demo.body")}</p></div><span className="tag">{t("tenant.privacy.demo.readOnly")}</span></div><div className="demo-boundary"><span aria-hidden="true">◇</span><p><b>{t("tenant.privacy.demo.noOperations")}</b><small>{t("tenant.privacy.demo.noOperationsBody")}</small></p></div><div className="privacy-demo-grid"><div><small>{t("tenant.privacy.policy.label")}</small><b>{t("tenant.privacy.demo.liveOnly")}</b><span>{t("tenant.privacy.demo.liveOnlyBody")}</span></div><div><small>{t("tenant.privacy.demo.content")}</small><b>{t("tenant.privacy.demo.hidden")}</b><span>{t("tenant.privacy.demo.hiddenBody")}</span></div><div><small>{t("tenant.privacy.demo.destructive")}</small><b>{t("tenant.privacy.common.unavailable")}</b><span>{t("tenant.privacy.demo.destructiveBody")}</span></div></div></section>;
  if(loading&&!policy)return <section className="panel privacy-loading" aria-busy="true"><p className="sr-only" role="status" aria-label={t("tenant.privacy.loading")}>{t("tenant.privacy.loading")}</p><span aria-hidden="true" className="group-skeleton group-skeleton-title"/><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/></section>;
  if(!policy||!policyForm)return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.privacy.error.unavailable")}</b><p>{error??t("tenant.privacy.error.missingPolicy")}</p><button className="button small" onClick={()=>void load()}>{t("tenant.privacy.common.tryAgain")}</button></div></section>;
  const scopeNames:Record<string,string>={TENANT:t("tenant.privacy.scope.tenant"),ZAMMAD_TICKET:t("tenant.privacy.scope.case"),REFERENCE:t("tenant.privacy.scope.reference"),PARTICIPANT:t("tenant.privacy.scope.participant"),GROUP_BINDING:t("tenant.privacy.scope.group"),WHATSAPP_GROUP:t("tenant.privacy.scope.groupHistory"),ZAMMAD_USER:t("tenant.privacy.scope.user")};
  const requestNames:Record<string,string>={EXPORT:t("tenant.privacy.request.export"),DELETE:t("tenant.privacy.request.delete")};
  const policyBlockers:string[]=[];for(const [value,min,max,name] of [[policyForm.resolvedCaseDays,1,3650,t("tenant.privacy.policy.resolvedRetention")],[policyForm.mediaDays,1,3650,t("tenant.privacy.policy.mediaRetention")],[policyForm.unmatchedDiagnosticHours,1,24,t("tenant.privacy.policy.unmatchedDiagnostics")],[policyForm.exportTtlHours,1,168,t("tenant.privacy.policy.exportLifetime")]] as const){const number=Number(value);if(!Number.isInteger(number)||number<min||number>max)policyBlockers.push(t("tenant.privacy.validation.range",{name,min:formatNumber(min,locale),max:formatNumber(max,locale)}))}
  const updatePolicy=<K extends keyof PrivacyPolicyForm>(key:K,value:PrivacyPolicyForm[K])=>{if(busy==="policy")return;privacyDirty.current=true;setPolicyForm(current=>current?{...current,[key]:value}:current);setError(null);setNotice(null)};
  const savePolicy=async()=>{if(!canManagePolicy||!dirty||policyBlockers.length||busy)return;privacyLoadFence.current.invalidate();setBusy("policy");setError(null);setNotice(null);try{const response=await fetch("/api/privacy/policy",{method:"PUT",headers:mutationHeaders,body:JSON.stringify({state:policyForm.state,resolvedCaseDays:Number(policyForm.resolvedCaseDays),includeOpenCases:policyForm.includeOpenCases,mediaDays:Number(policyForm.mediaDays),unmatchedDiagnosticHours:Number(policyForm.unmatchedDiagnosticHours),exportTtlHours:Number(policyForm.exportTtlHours),expectedVersion:policy.version})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const updated=await response.json() as PrivacyPolicy;if(!privacyLifetime.current.mounted)return;privacyLoadFence.current.invalidate();const next=privacyPolicyForm(updated);setPolicy(updated);setPolicyForm(next);setSavedPolicyForm(next);setNotice(t("tenant.privacy.notice.policySaved"));}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.privacy.error.savePolicy")));}finally{setBusy(null)}};
  const release=async()=>{if(!releaseHold||busy)return;setBusy(`hold:${releaseHold.id}`);setError(null);try{const response=await fetch(`/api/privacy/holds/${encodeURIComponent(releaseHold.id)}/release`,{method:"POST",headers:mutationHeaders,body:"{}"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const releasedId=releaseHold.id;setHolds(current=>current.map(hold=>hold.id===releasedId?{...hold,state:"RELEASED",updated_at:new Date().toISOString()}:hold));setReleaseHold(null);setNotice(t("tenant.privacy.notice.holdReleased"));}catch(releaseError){setReleaseHold(null);setError(operatorFailureMessage(releaseError, t("tenant.privacy.error.releaseHold")));}finally{setBusy(null)}};
  const retry=async(confirmation:string|undefined,idempotencyKey:string)=>{if(!retryRequest||busy)return;setBusy(`retry:${retryRequest.id}`);setError(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(retryRequest.id)}/retry`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({confirmation})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const retriedId=retryRequest.id;setRequests(current=>current.map(request=>request.id===retriedId?{...request,state:"QUEUED",error_code:null,safe_error:null,updated_at:new Date().toISOString()}:request));setRetryRequest(null);setNotice(t("tenant.privacy.notice.requestRetried"));}catch(retryError){setRetryRequest(null);setError(operatorFailureMessage(retryError, t("tenant.privacy.error.retryRequest")));}finally{setBusy(null)}};
  const prepareDownload=async(request:PrivacyRequest)=>{if(busy)return;setBusy(`download:${request.id}`);setError(null);setDownload(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(request.id)}/download`,{method:"POST",headers:mutationHeaders,body:"{}"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const result=await response.json() as {url?:string;expiresIn?:number};const ttl=Number(result.expiresIn);if(!result.url||!Number.isInteger(ttl)||ttl<1||ttl>300||new URL(result.url).protocol!=="https:")throw operatorLocalFailure(t("tenant.privacy.error.invalidDownload"));setDownload({requestId:request.id,url:result.url,expiresIn:ttl});window.setTimeout(()=>setDownload(current=>current?.url===result.url?null:current),ttl*1000);setNotice(t("tenant.privacy.notice.downloadReady"));}catch(downloadError){setError(operatorFailureMessage(downloadError, t("tenant.privacy.error.prepareDownload")));}finally{setBusy(null)}};
  const activeHolds=holds.filter(hold=>hold.state==="ACTIVE").length;const pendingRequests=requests.filter(request=>["QUEUED","RUNNING"].includes(request.state)).length;const failedRequests=requests.filter(request=>request.state.startsWith("FAILED")||request.state==="BLOCKED_LEGAL_HOLD").length;
  return <div className="privacy-settings" data-unsaved={dirty||undefined}>
    <section className="privacy-summary" aria-label={t("tenant.privacy.summary.aria")}><div><small>{t("tenant.privacy.policy.label")}</small><strong>{policy.state==="ACTIVE"?t("tenant.privacy.value.active"):t("tenant.privacy.value.paused")}</strong><span>{t("tenant.privacy.summary.versionReview",{version:formatNumber(policy.version,locale)})} <RelativeTime value={policy.next_sweep_at}/></span></div><div><small>{t("tenant.privacy.summary.activeHolds")}</small><strong>{formatNumber(activeHolds,locale)}</strong><span>{activeHolds?t("tenant.privacy.summary.scopesProtected"):t("tenant.privacy.summary.noActiveHold")}</span></div><div><small>{t("tenant.privacy.summary.requestsProgress")}</small><strong>{formatNumber(pendingRequests,locale)}</strong><span>{failedRequests?t("tenant.privacy.summary.needRecovery",{count:formatNumber(failedRequests,locale)}):t("tenant.privacy.summary.noFailed")}</span></div></section>
    {error?<div className="settings-feedback error privacy-feedback" role="alert"><span>!</span><p>{error}</p><button className="button small" onClick={()=>{if(confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))){privacyDirty.current=false;setPolicyForm(savedPolicyForm);void load()}}}>{t("tenant.privacy.action.reload")}</button>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}
    {notice?<div className="settings-feedback success privacy-feedback" role="status"><span>✓</span><p>{notice}</p></div>:null}
    {download?<div className="privacy-download-ready" role="status"><span>↗</span><p><b>{t("tenant.privacy.download.title")}</b><small>{t("tenant.privacy.download.body",{seconds:formatNumber(download.expiresIn,locale)})}</small></p>{isFixturePreview?<span className="tag">{t("tenant.privacy.download.previewVerified")}</span>:<a className="button small primary" href={download.url} target="_blank" rel="noreferrer">{t("tenant.privacy.action.openExport")}</a>}</div>:null}
    <section className="panel privacy-policy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.policy.title")}</h2><p>{t("tenant.privacy.policy.body")}</p></div><Status value={policy.state}/></div>{!canManagePolicy?<div className="settings-readonly"><span>◉</span><p><b>{t("tenant.privacy.policy.readOnly")}</b><small>{role==="auditor"?t("tenant.privacy.policy.auditorBody"):t("tenant.privacy.policy.ownerOnly")}</small></p></div>:null}<div className="privacy-policy-fields"><label>{t("tenant.privacy.policy.lifecycle")}<select value={policyForm.state} disabled={!canManagePolicy||busy==="policy"} onChange={event=>updatePolicy("state",event.target.value as PrivacyPolicyForm["state"])}><option value="ACTIVE">{t("tenant.privacy.value.active")}</option><option value="PAUSED">{t("tenant.privacy.policy.pausedCleanup")}</option></select><small>{t("tenant.privacy.policy.lifecycleHelp")}</small></label><label>{t("tenant.privacy.policy.resolvedDays")}<input type="number" min={1} max={3650} value={policyForm.resolvedCaseDays} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("resolvedCaseDays",event.target.value)}/><small>{t("tenant.privacy.policy.resolvedHelp")}</small></label><label>{t("tenant.privacy.policy.mediaDays")}<input type="number" min={1} max={3650} value={policyForm.mediaDays} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("mediaDays",event.target.value)}/><small>{t("tenant.privacy.policy.mediaHelp")}</small></label><label>{t("tenant.privacy.policy.diagnosticHours")}<input type="number" min={1} max={24} value={policyForm.unmatchedDiagnosticHours} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("unmatchedDiagnosticHours",event.target.value)}/><small>{t("tenant.privacy.policy.diagnosticHelp")}</small></label><label>{t("tenant.privacy.policy.exportHours")}<input type="number" min={1} max={168} value={policyForm.exportTtlHours} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("exportTtlHours",event.target.value)}/><small>{t("tenant.privacy.policy.exportHelp")}</small></label><div className="setting-row settings-toggle-row"><span><b>{t("tenant.privacy.policy.includeOpen")}</b><small>{t("tenant.privacy.policy.includeOpenHelp")}</small></span><button type="button" className={`switch ${policyForm.includeOpenCases?"on":""}`} aria-pressed={policyForm.includeOpenCases} aria-label={t("tenant.privacy.policy.includeOpenAria")} disabled={!canManagePolicy||busy==="policy"} onClick={()=>updatePolicy("includeOpenCases",!policyForm.includeOpenCases)}><span/></button></div></div><div className="privacy-policy-evidence"><span className={policy.zammad_privacy_configured?"ready":"blocked"}>{policy.zammad_privacy_configured?"✓":"!"}</span><p><b>{policy.zammad_privacy_configured?t("tenant.privacy.policy.accessReady"):t("tenant.privacy.policy.accessMissing")}</b><small>{t("tenant.privacy.policy.accessHelp")}</small></p></div>{policyBlockers.length?<div className="settings-validation" role="status"><b>{t("tenant.privacy.validation.resolve")}</b><ul>{policyBlockers.map(item=><li key={item}>{item}</li>)}</ul></div>:null}<div className="save-bar"><span>{dirty?t("tenant.privacy.policy.unsaved"):<>{t("tenant.privacy.policy.saved")} <RelativeTime value={policy.updated_at} pastOnly/></>}{!canManagePolicy?t("tenant.privacy.policy.ownerRequired"):""}</span><div>{dirty?<button type="button" className="button secondary" disabled={busy==="policy"} onClick={()=>{if(busy==="policy")return;setPolicyForm(savedPolicyForm);setError(null)}}>{t("tenant.privacy.action.discard")}</button>:null}<button type="button" className="button primary" disabled={!canManagePolicy||!dirty||Boolean(policyBlockers.length)||busy!==null} onClick={()=>void savePolicy()}>{busy==="policy"?t("tenant.privacy.action.saving"):t("tenant.privacy.action.savePolicy")}</button></div></div></section>
    <section className="panel table-panel privacy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.holds.title")}</h2><p>{t("tenant.privacy.holds.body")}</p></div>{canManageHolds?<button className="button primary icon-action" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setHoldOpen(true)}}><MarketingIcon name="plus"/>{t("tenant.privacy.action.createHold")}</button>:<span className="tag">{t("tenant.privacy.common.readOnly")}</span>}</div>{holds.length?<WideTable><table><thead><tr><th>{t("tenant.privacy.table.scope")}</th><th>{t("tenant.privacy.table.reason")}</th><th>{t("tenant.privacy.table.status")}</th><th>{t("tenant.privacy.table.expiry")}</th><th><span className="sr-only">{t("tenant.privacy.table.actions")}</span></th></tr></thead><tbody>{holds.map(hold=><tr key={hold.id}><td><div className="cell-main"><span className="privacy-scope-icon">⌁</span><span><b>{scopeNames[hold.scope_type]??t("tenant.privacy.common.unavailable")}</b><small><bdi>{privacyScopeReadback(hold.scope_type,hold.scope_value,t)}</bdi></small></span></div></td><td><span className="privacy-safe-text"><bdi>{hold.reason}</bdi></span></td><td><Status value={hold.state}/></td><td>{hold.expires_at?<RelativeTime value={hold.expires_at}/>:t("tenant.privacy.holds.noExpiry")}</td><td>{canManageHolds&&hold.state==="ACTIVE"?<button className="text-button danger-text" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setReleaseHold(hold)}}>{t("tenant.privacy.action.release")}</button>:<span className="team-protected">—</span>}</td></tr>)}</tbody></table></WideTable>:<Empty title={t("tenant.privacy.holds.emptyTitle")} body={t("tenant.privacy.holds.emptyBody")}/>}</section>
    <section className="panel table-panel privacy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.requests.title")}</h2><p>{t("tenant.privacy.requests.body")}</p></div><div className="privacy-request-actions">{canExport?<button className="button secondary" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRequestType("EXPORT")}}>{t("tenant.privacy.action.requestExport")}</button>:null}{canDelete?<button className="button connection-detail-danger-button" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRequestType("DELETE")}}>{t("tenant.privacy.action.requestDeletion")}</button>:null}</div></div>{requests.length?<WideTable><table><thead><tr><th>{t("tenant.privacy.table.request")}</th><th>{t("tenant.privacy.table.scope")}</th><th>{t("tenant.privacy.table.status")}</th><th>{t("tenant.privacy.table.exportFile")}</th><th>{t("tenant.privacy.table.updated")}</th><th><span className="sr-only">{t("tenant.privacy.table.actions")}</span></th></tr></thead><tbody>{requests.map(request=><tr key={request.id}><td><div className="cell-main"><span className={`privacy-request-icon ${request.request_type.toLowerCase()}`}>{request.request_type==="EXPORT"?"↗":"×"}</span><span><b>{requestNames[request.request_type]??t("tenant.privacy.common.unavailable")}</b></span></div></td><td><span className="privacy-scope"><b>{scopeNames[request.scope_type]??t("tenant.privacy.common.unavailable")}</b><small><bdi>{privacyScopeReadback(request.scope_type,request.scope_value,t)}</bdi></small></span></td><td><Status value={request.state}/>{request.safe_error?<small className="privacy-request-error">{t("tenant.errors.privacyReview")}</small>:null}</td><td>{request.artifact_id?<span className="privacy-artifact"><b>{formatBytes(request.artifact_byte_size,locale)}</b><small>{t("tenant.privacy.requests.expires")} <RelativeTime value={request.artifact_expires_at}/></small></span>:"—"}</td><td><RelativeTime value={request.updated_at} pastOnly/></td><td><div className="privacy-row-actions"><button className="text-button" onClick={()=>{privacyLoadFence.current.invalidate();setLoading(false);setDetailId(request.id)}}>{t("tenant.privacy.action.inspect")}</button>{canExport&&request.request_type==="EXPORT"&&request.state==="SUCCEEDED"&&request.artifact_expires_at?<button className="text-button" disabled={busy!==null} onClick={()=>void prepareDownload(request)}>{busy===`download:${request.id}`?t("tenant.privacy.action.preparing"):t("tenant.privacy.action.download")}</button>:null}{["FAILED_RETRYABLE","FAILED_TERMINAL","BLOCKED_LEGAL_HOLD"].includes(request.state)&&((request.request_type==="EXPORT"&&canExport)||(request.request_type==="DELETE"&&canDelete))?<button className="text-button" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRetryRequest(request)}}>{t("tenant.privacy.action.retry")}</button>:null}</div></td></tr>)}</tbody></table></WideTable>:<Empty title={t("tenant.privacy.requests.emptyTitle")} body={t("tenant.privacy.requests.emptyBody")}/>}</section>
    {holdOpen?<PrivacyHoldDialog recoveryScope={recoveryScope} recovered={()=>{privacyLoadFence.current.invalidate();setHoldOpen(false);setRequestType(null);setNotice(t("tenant.privacy.recovery.confirmed"));void load(true)}} beforeSubmit={()=>{privacyLoadFence.current.invalidate();setLoading(false)}} mutationHeaders={mutationHeaders} close={()=>setHoldOpen(false)} complete={async hold=>{privacyLoadFence.current.invalidate();setLoading(false);setHolds(current=>[hold,...current]);setHoldOpen(false);setNotice(t("tenant.privacy.notice.holdCreated"))}}/>:null}
    {requestType?<PrivacyRequestDialog recoveryScope={recoveryScope} recovered={()=>{privacyLoadFence.current.invalidate();setHoldOpen(false);setRequestType(null);setNotice(t("tenant.privacy.recovery.confirmed"));void load(true)}} beforeSubmit={()=>{privacyLoadFence.current.invalidate();setLoading(false)}} key={requestType} requestType={requestType} mutationHeaders={mutationHeaders} close={()=>setRequestType(null)} complete={async request=>{privacyLoadFence.current.invalidate();setLoading(false);setRequests(current=>[request,...current]);setRequestType(null);setNotice(t(requestType==="EXPORT"?"tenant.privacy.notice.exportSubmitted":"tenant.privacy.notice.deleteSubmitted"))}}/>:null}
    {releaseHold?<ModalDialog close={()=>setReleaseHold(null)} className="modal-backdrop" aria-labelledby="release-hold-title"><div className="modal privacy-confirm-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.release.eyebrow")}</span><h2 id="release-hold-title">{t("tenant.privacy.release.title")}</h2><p>{t("tenant.privacy.release.body")}</p></div><button aria-label={t("tenant.privacy.release.cancelAria")} onClick={()=>setReleaseHold(null)}>×</button></div><div className="privacy-confirm-facts"><span><small>{t("tenant.privacy.table.scope")}</small><b>{scopeNames[releaseHold.scope_type]??t("tenant.privacy.common.unavailable")}</b></span><span><small>{t("tenant.privacy.release.value")}</small><b className="mono"><bdi>{privacyScopeReadback(releaseHold.scope_type,releaseHold.scope_value,t)}</bdi></b></span></div><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.release.confirmOwner")}</b><small>{t("tenant.privacy.release.confirmOwnerBody")}</small></p></div><div className="modal-actions"><button className="button secondary" onClick={()=>setReleaseHold(null)}>{t("tenant.privacy.action.keepHold")}</button><button className="button connection-detail-danger-button" disabled={busy!==null} onClick={()=>void release()}>{busy===`hold:${releaseHold.id}`?t("tenant.privacy.action.releasing"):t("tenant.privacy.action.releaseHold")}</button></div></div></ModalDialog>:null}
    {retryRequest?<PrivacyRetryDialog request={retryRequest} busy={busy!==null} close={()=>setRetryRequest(null)} retry={retry}/>:null}
    {detailId?<PrivacyRequestDetail key={detailId} id={detailId} close={()=>setDetailId(null)}/>:null}
  </div>;
}

type PrivacySubmissionKind = "EXPORT" | "DELETE" | "HOLD";
type PrivacyPendingSubmission = { operationId: string; kind: PrivacySubmissionKind };

function privacyFriendlyScopeValue(scopeType: string, value: string) {
  return scopeType === "ZAMMAD_TICKET" ? value.trim().replace(/^#/u, "") : value.trim();
}

function parsePrivacyPendingSubmission(raw: string): PrivacyPendingSubmission {
  if (raw.length > 256) throw new Error("Invalid pending submission");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pending submission");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "kind,operationId" || typeof row.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.operationId)
    || typeof row.kind !== "string" || !["EXPORT", "DELETE", "HOLD"].includes(row.kind)) throw new Error("Invalid pending submission");
  return { operationId: row.operationId, kind: row.kind as PrivacySubmissionKind };
}

function parsePrivacyMutationAcknowledgement(value: unknown, kind: PrivacySubmissionKind, scopeType: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unconfirmed submission");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.id)
    || typeof row.state !== "string" || !(kind === "HOLD" ? ["ACTIVE"] : ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "BLOCKED_LEGAL_HOLD"]).includes(row.state)
    || row.request_type !== undefined && row.request_type !== kind || row.kind !== undefined && row.kind !== kind
    || row.scope_type !== undefined && row.scope_type !== scopeType) throw new Error("Unconfirmed submission");
  return { id: row.id, state: row.state };
}

function parsePrivacySubmissionReceipt(value: unknown): { state: "APPLIED"; id: string } | { state: "UNKNOWN" } | { state: "NOT_APPLIED"; terminal: true; effect: "NONE" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receipt");
  const row = value as Record<string, unknown>;
  if (row.state === "APPLIED" && typeof row.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.id)) return { state: "APPLIED", id: row.id };
  if (row.state === "UNKNOWN") return { state: "UNKNOWN" };
  if (row.state === "NOT_APPLIED" && row.terminal === true && row.effect === "NONE") return { state: "NOT_APPLIED", terminal: true, effect: "NONE" };
  throw new Error("Invalid receipt");
}

function usePrivacySubmissionRecovery(recoveryScope: string, kind: PrivacySubmissionKind, mutationHeaders: Record<string, string>, recovered: () => void) {
  const { t } = useI18n();
  const key = `wasalx:privacy-submission:v1:${recoveryScope}`;
  const [ready, setReady] = useState(false), [pending, setPending] = useState<PrivacyPendingSubmission | null>(null);
  const [checking, setChecking] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const state = useRef({ mounted: false, key, pending: null as PrivacyPendingSubmission | null, ready: false, checking: false });
  const requests = useRef(createReplaceableRequestController());
  useLayoutEffect(() => {
    const current = state.current, controller = requests.current;
    current.mounted = true; current.key = key; current.ready = false;
    const timer = window.setTimeout(() => {
      try { const raw = sessionStorage.getItem(key); const value = raw === null ? null : parsePrivacyPendingSubmission(raw);
        current.pending = value; current.ready = true; setPending(value); setReady(true);
      } catch { setError(t("tenant.privacy.recovery.storage")); }
    }, 0);
    return () => { current.mounted = false; current.ready = false; window.clearTimeout(timer); controller.abort(); };
  }, [key, t]);
  const start = () => {
    if (!state.current.mounted || !state.current.ready || state.current.pending || state.current.checking) return null;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing !== null) { const value = parsePrivacyPendingSubmission(existing); state.current.pending = value; setPending(value); return null; }
      const intent = { operationId: crypto.randomUUID(), kind };
      sessionStorage.setItem(key, JSON.stringify(intent)); state.current.pending = intent; setPending(intent); setNotice(null);
      return intent;
    } catch { state.current.ready = false; setReady(false); setError(t("tenant.privacy.recovery.storage")); return null; }
  };
  const finish = (intent: PrivacyPendingSubmission) => {
    if (!state.current.mounted || state.current.key !== key || state.current.pending?.operationId !== intent.operationId) return false;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === null || parsePrivacyPendingSubmission(raw).operationId !== intent.operationId) throw new Error("Changed pending submission");
      sessionStorage.removeItem(key); state.current.pending = null; setPending(null); return true;
    } catch { state.current.ready = false; setReady(false); setError(t("tenant.privacy.recovery.storage")); return false; }
  };
  const reconcile = async (cancel: boolean) => {
    const intent = state.current.pending;
    if (!intent || !state.current.ready || state.current.checking) return;
    state.current.checking = true; setChecking(true); setError(null); setNotice(null);
    const controller = requests.current.begin();
    const current = () => state.current.mounted && state.current.key === key && !controller.signal.aborted && state.current.pending?.operationId === intent.operationId;
    try {
      const response = await fetch("/api/privacy/receipt", { method: "POST", headers: mutationHeaders, cache: "no-store", signal: controller.signal,
        body: JSON.stringify({ ...intent, action: cancel ? "CANCEL_IF_UNADMITTED" : "LOOKUP" }) });
      if (!current()) return;
      if (!response.ok) { const message = await apiError(response); if (current()) setError(message); return; }
      const receipt = parsePrivacySubmissionReceipt(await response.json());
      if (!current()) return;
      if (receipt.state === "APPLIED") { if (finish(intent)) recovered(); }
      else if (receipt.state === "NOT_APPLIED") { if (finish(intent)) setNotice(t("tenant.privacy.recovery.cancelled")); }
      else setError(t("tenant.privacy.recovery.unknown"));
    } catch { if (current()) setError(t("tenant.privacy.recovery.unknown")); }
    finally { if (state.current.mounted && state.current.key === key) { state.current.checking = false; setChecking(false); } }
  };
  return { ready: ready && !pending && !checking, pending, checking, error, notice, start, finish, reconcile };
}

function PrivacySubmissionRecovery({ recovery, saving }: { recovery: ReturnType<typeof usePrivacySubmissionRecovery>; saving: boolean }) {
  const { t } = useI18n();
  if (!recovery.pending && !recovery.error && !recovery.notice) return null;
  return <div className="privacy-dialog-wide">
    {recovery.pending ? <div className="settings-feedback" role="status"><p>{t("tenant.privacy.recovery.unknown")}<br /><small>{t("tenant.privacy.recovery.help")}</small></p>
      <button type="button" className="button small secondary" disabled={saving || recovery.checking} onClick={() => void recovery.reconcile(false)}>{t("tenant.privacy.recovery.check")}</button>
      <button type="button" className="button small secondary" disabled={saving || recovery.checking} onClick={() => void recovery.reconcile(true)}>{t("tenant.privacy.recovery.cancel")}</button></div> : null}
    {recovery.notice ? <p role="status">{recovery.notice}</p> : null}
    {recovery.error ? <div className="settings-feedback error" role="alert"><p>{recovery.error}</p>{requiresPrivilegedReauthentication(recovery.error) ? <a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a> : null}</div> : null}
  </div>;
}


type PrivacyTargetSelection = { scope_type: string; display: string; selection_sha256: string };

function parsePrivacyTargetSelection(value: unknown, scopeType: string): PrivacyTargetSelection {
  if (scopeType !== "ZAMMAD_TICKET" && scopeType !== "ZAMMAD_USER") throw new Error("Invalid target readback");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid target readback");
  const row = value as Record<string, unknown>;
  if (row.scope_type !== scopeType || typeof row.display !== "string" || !row.display.trim() || row.display.length > 1000
    || typeof row.selection_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.selection_sha256)) throw new Error("Invalid target readback");
  return { scope_type: scopeType, display: row.display, selection_sha256: row.selection_sha256 };
}

function privacyScopeReadback(scopeType: string, value: string | null, t: TenantTranslator) {
  if (scopeType === "ZAMMAD_USER" || scopeType === "ZAMMAD_TICKET" && !/^#[0-9]{1,32}$/u.test(value ?? "")) return t("tenant.privacy.common.restricted");
  return value ?? t("tenant.privacy.common.restricted");
}

function usePrivacyTargetSelection(scopeType: string, scopeValue: string, mode: string, mutationHeaders: Record<string, string>) {
  const { t } = useI18n();
  const context = JSON.stringify([scopeType, scopeValue, mode]);
  const [snapshot, setSnapshot] = useState<{ context: string; value: PrivacyTargetSelection } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createReplaceableRequestController());
  const fence = useRef(createLatestRequestFence());
  const current = useRef({ context, mounted: false });
  useLayoutEffect(() => {
    const state = current.current, pending = requests.current, generation = fence.current;
    state.context = context; state.mounted = true;
    return () => { state.mounted = false; pending.abort(); generation.invalidate(); };
  }, [context]);
  const native = scopeType === "ZAMMAD_TICKET" || scopeType === "ZAMMAD_USER";
  const selection = snapshot?.context === context ? snapshot.value : null;
  const isActive = () => current.current.mounted && current.current.context === context;
  const clear = () => { requests.current.abort(); fence.current.invalidate(); setSnapshot(null); setLoading(false); setError(null); };
  const begin = () => {
    const execution = fence.current.begin(), controller = requests.current.begin();
    return { signal: controller.signal, isCurrent: () => isActive() && fence.current.isCurrent(execution) && !controller.signal.aborted };
  };
  const canLookup = scopeType === "ZAMMAD_TICKET" ? /^#?[0-9]{1,32}$/u.test(scopeValue.trim())
    : scopeType === "ZAMMAD_USER" && scopeValue.trim().length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(scopeValue.trim());
  const lookup = async () => {
    if (!canLookup) return;
    const execution = begin();
    let message = t("tenant.privacy.target.failed");
    setSnapshot(null); setLoading(true); setError(null);
    try {
      const response = await fetch("/api/privacy/target", { method: "POST", cache: "no-store", headers: mutationHeaders,
        signal: execution.signal, body: JSON.stringify({ scopeType, scopeValue: privacyFriendlyScopeValue(scopeType,scopeValue) }) });
      if (!execution.isCurrent()) return;
      if (!response.ok) { message = response.status === 409 ? t("tenant.privacy.target.stale")
        : response.status === 404 ? t("tenant.privacy.target.notFound") : await apiError(response); throw new Error("Lookup rejected"); }
      const value = parsePrivacyTargetSelection(await response.json(), scopeType);
      if (execution.isCurrent()) setSnapshot({ context, value });
    } catch {
      if (execution.isCurrent()) setError(message);
    } finally { if (execution.isCurrent()) setLoading(false); }
  };
  // The server re-resolves the friendly input; this fingerprint detects a changed selection and grants no authority.
  return { native, selection, ready: !native || Boolean(selection) && !loading, loading, error, canLookup, lookup, clear, begin, isActive };
}

function PrivacyScopeTarget({ scopeType, scopeValue, change, target, disabled, hold }: {
  scopeType: string; scopeValue: string; change: (value: string) => void;
  target: ReturnType<typeof usePrivacyTargetSelection>; disabled: boolean; hold: boolean;
}) {
  const { t } = useI18n();
  const customer = scopeType === "ZAMMAD_USER";
  const inputId = hold ? "privacy-hold-target" : "privacy-request-target";
  return <>
    <label htmlFor={inputId}>{t(target.native ? customer ? "tenant.privacy.target.customerEmail" : "tenant.privacy.target.caseNumber" : "tenant.privacy.common.exactScope")}
      <input id={inputId} required type={customer ? "email" : "text"} dir={target.native ? "ltr" : "auto"} inputMode={scopeType === "ZAMMAD_TICKET" ? "numeric" : customer ? "email" : "text"}
        maxLength={customer ? 320 : scopeType === "ZAMMAD_TICKET" ? 33 : 512} disabled={disabled} value={scopeValue} onChange={event => change(event.target.value)}
        aria-describedby={`${inputId}-help`} />
      <small id={`${inputId}-help`}>{t(target.native ? customer ? "tenant.privacy.target.customerHelp" : "tenant.privacy.target.caseHelp"
        : hold ? "tenant.privacy.holdDialog.scopeHelp" : "tenant.privacy.requestDialog.scopeHelp")}</small>
    </label>
    {target.native ? <div className="privacy-dialog-wide"><button type="button" className="button secondary" disabled={disabled || target.loading || !target.canLookup} onClick={() => { change(scopeValue); void target.lookup(); }}>
      {t(target.loading ? "tenant.privacy.target.loading" : customer ? "tenant.privacy.target.checkCustomer" : "tenant.privacy.target.checkCase")}</button>
    {target.selection ? <div className="settings-feedback success" role="status"><p className="privacy-target-readback"><b>{t(customer ? "tenant.privacy.target.selectedCustomer" : "tenant.privacy.target.selectedCase")}</b><br />
      <bdi dir="auto">{target.selection.display}</bdi><br /><small>{t("tenant.privacy.target.review")}</small></p></div> : null}
    {target.error ? <div className="settings-feedback error" role="alert"><p>{target.error}</p>{requiresPrivilegedReauthentication(target.error)
      ? <a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a> : null}</div> : null}</div> : null}
  </>;
}


export function PrivacyHoldDialog({mutationHeaders,close,complete,beforeSubmit,recoveryScope,recovered}:{recoveryScope:string;recovered:()=>void;mutationHeaders:Record<string,string>;beforeSubmit?:()=>void;close:()=>void;complete:(hold:PrivacyHold)=>Promise<void>}) {
  const {locale,t}=useI18n();
  const [scopeType,setScopeType]=useState("TENANT");const [scopeValue,setScopeValue]=useState("");const [reason,setReason]=useState("");const [expiresAt,setExpiresAt]=useState("");const [minimumExpiry]=useState(()=>new Date(Date.now()+86_400_000).toISOString().slice(0,10));const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);
  const target=usePrivacyTargetSelection(scopeType,scopeValue,"HOLD",mutationHeaders);const inFlight=useRef(false);const recovery=usePrivacySubmissionRecovery(recoveryScope,"HOLD",mutationHeaders,recovered);const needsValue=scopeType!=="TENANT";const valid=recovery.ready&&target.ready&&(!needsValue||scopeValue.trim().length>0)&&reason.trim().length>=3;
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!valid||saving||inFlight.current)return;
    const intent=recovery.start();if(!intent)return;
    beforeSubmit?.();
    const execution=target.begin();inFlight.current=true;setSaving(true);setError(null);
    try {
      const expiry=expiresAt?new Date(`${expiresAt}T23:59:59`).toISOString():null;
      const response=await fetch("/api/privacy/holds",{method:"POST",headers:{...mutationHeaders,"idempotency-key":intent.operationId},signal:execution.signal,
        body:JSON.stringify({scopeType,scopeValue:needsValue?privacyFriendlyScopeValue(scopeType,scopeValue):undefined,selection_sha256:target.selection?.selection_sha256,reason:reason.trim(),expiresAt:expiry??undefined})});
      if(!execution.isCurrent())return;
      if(!response.ok){
        const message=response.status===409?t("tenant.privacy.target.stale"):await apiError(response);
        if(execution.isCurrent()){if([401,403,409].includes(response.status))target.clear();setError(message);}
        return;
      }
      const returned=parsePrivacyMutationAcknowledgement(await response.json(),"HOLD",scopeType);
      if(!execution.isCurrent()||!recovery.finish(intent))return;
      const timestamp=new Date().toISOString();
      await complete({id:returned.id,scope_type:scopeType,scope_value:target.native?null:(needsValue?scopeValue.trim():t("tenant.privacy.scope.tenant")),scope_sha256:"pending-authoritative-hash",reason:reason.trim(),state:returned.state,expires_at:expiry,created_at:timestamp,updated_at:timestamp});
    }catch{if(execution.isCurrent())setError(t("tenant.privacy.recovery.unknown"));}
    finally{if(target.isActive()){inFlight.current=false;setSaving(false);}}
  };
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="create-hold-title"><form className="modal privacy-dialog" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.holdDialog.eyebrow")}</span><h2 id="create-hold-title">{t("tenant.privacy.holdDialog.title")}</h2><p>{t("tenant.privacy.holdDialog.body")}</p></div><button type="button" aria-label={t("tenant.privacy.holdDialog.closeAria")} onClick={close}>×</button></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}<div className="privacy-dialog-fields"><PrivacySubmissionRecovery recovery={recovery} saving={saving}/><label>{t("tenant.privacy.holdDialog.protectedScope")}<select value={scopeType} disabled={saving} onChange={event=>{target.clear();setScopeType(event.target.value);setScopeValue("");setError(null);}}><option value="TENANT">{t("tenant.privacy.scope.tenant")}</option><option value="ZAMMAD_TICKET">{t("tenant.privacy.scope.case")}</option><option value="REFERENCE">{t("tenant.privacy.scope.reference")}</option><option value="PARTICIPANT">{t("tenant.privacy.scope.participant")}</option><option value="GROUP_BINDING">{t("tenant.privacy.scope.group")}</option><option value="WHATSAPP_GROUP">{t("tenant.privacy.scope.groupHistory")}</option><option value="ZAMMAD_USER">{t("tenant.privacy.scope.user")}</option></select></label>{needsValue?<PrivacyScopeTarget scopeType={scopeType} scopeValue={scopeValue} target={target} disabled={saving} hold={true} change={value=>{target.clear();setScopeValue(value);setError(null);}}/>:null}<label className="privacy-dialog-wide">{t("tenant.privacy.table.reason")}<textarea disabled={saving} required rows={4} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} placeholder={t("tenant.privacy.placeholder.holdReason")}/><small>{t("tenant.privacy.common.characterCount",{count:formatNumber(reason.length,locale),max:formatNumber(500,locale)})}</small></label><label>{t("tenant.privacy.holdDialog.optionalExpiry")}<input disabled={saving} type="date" min={minimumExpiry} value={expiresAt} onChange={event=>setExpiresAt(event.target.value)}/><small>{t("tenant.privacy.holdDialog.expiryHelp")}</small></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className="button primary" disabled={!valid||saving}>{saving?t("tenant.privacy.action.creating"):t("tenant.privacy.action.createHold")}</button></div></form></ModalDialog>
}

export function PrivacyRequestDialog({requestType,mutationHeaders,close,complete,beforeSubmit,recoveryScope,recovered}:{requestType:"EXPORT"|"DELETE";recoveryScope:string;recovered:()=>void;mutationHeaders:Record<string,string>;beforeSubmit?:()=>void;close:()=>void;complete:(request:PrivacyRequest)=>Promise<void>}) {
  const {t}=useI18n();
  const [scopeType,setScopeType]=useState("REFERENCE");const [scopeValue,setScopeValue]=useState("");const [confirmation,setConfirmation]=useState("");const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);const target=usePrivacyTargetSelection(scopeType,scopeValue,requestType,mutationHeaders);const inFlight=useRef(false);const recovery=usePrivacySubmissionRecovery(recoveryScope,requestType,mutationHeaders,recovered);const needsValue=scopeType!=="TENANT";const phrase=scopeType==="TENANT"?"DELETE TENANT DATA":"DELETE";const valid=recovery.ready&&target.ready&&(!needsValue||scopeValue.trim().length>0)&&(requestType==="EXPORT"||confirmation===phrase);
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!valid||saving||inFlight.current)return;
    const intent=recovery.start();if(!intent)return;
    beforeSubmit?.();
    const execution=target.begin();inFlight.current=true;setSaving(true);setError(null);
    try {
      const response=await fetch("/api/privacy/requests",{method:"POST",headers:{...mutationHeaders,"idempotency-key":intent.operationId},signal:execution.signal,
        body:JSON.stringify({requestType,scopeType,scopeValue:needsValue?privacyFriendlyScopeValue(scopeType,scopeValue):undefined,selection_sha256:target.selection?.selection_sha256,confirmation:requestType==="DELETE"?confirmation:undefined})});
      if(!execution.isCurrent())return;
      if(!response.ok){
        // A hold refusal keeps the chosen target: picking it again cannot help.
        const held=response.status===409&&((await response.clone().json().catch(()=>null)) as {code?:unknown}|null)?.code==="LEGAL_HOLD_ACTIVE";
        const message=held?t("tenant.privacy.error.holdBlocksDeletion"):response.status===409?t("tenant.privacy.target.stale"):await apiError(response);
        if(execution.isCurrent()){if(!held&&[401,403,409].includes(response.status))target.clear();setError(message);}
        return;
      }
      const returned=parsePrivacyMutationAcknowledgement(await response.json(),requestType,scopeType);
      if(!execution.isCurrent()||!recovery.finish(intent))return;
      const timestamp=new Date().toISOString();
      await complete({id:returned.id,request_type:requestType,scope_type:scopeType,scope_value:target.native?null:needsValue?scopeValue.trim():t("tenant.privacy.scope.tenant"),scope_sha256:"pending-authoritative-hash",disposition:requestType==="EXPORT"?"EXPORT_ONLY":scopeType==="ZAMMAD_USER"?"ZAMMAD_USER_DATA_PRIVACY":"DELETE_TICKETS",state:returned.state,error_code:null,safe_error:null,completed_at:null,created_at:timestamp,updated_at:timestamp,artifact_id:null,artifact_byte_size:null,artifact_expires_at:null});
    }catch{if(execution.isCurrent())setError(t("tenant.privacy.recovery.unknown"));}
    finally{if(target.isActive()){inFlight.current=false;setSaving(false);}}
  };
  const isExport=requestType==="EXPORT";
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-request-title"><form className={`modal privacy-dialog ${requestType==="DELETE"?"privacy-delete-dialog":""}`} onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{t(isExport?"tenant.privacy.requestDialog.exportEyebrow":"tenant.privacy.requestDialog.deleteEyebrow")}</span><h2 id="privacy-request-title">{t(isExport?"tenant.privacy.requestDialog.exportTitle":"tenant.privacy.requestDialog.deleteTitle")}</h2><p>{t(isExport?"tenant.privacy.requestDialog.exportBody":"tenant.privacy.requestDialog.deleteBody")}</p></div><button type="button" aria-label={t("tenant.privacy.requestDialog.closeAria")} onClick={close}>×</button></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}<div className="privacy-dialog-fields"><PrivacySubmissionRecovery recovery={recovery} saving={saving}/><label>{t("tenant.privacy.table.scope")}<select value={scopeType} disabled={saving} onChange={event=>{target.clear();setScopeType(event.target.value);setScopeValue("");setError(null);setConfirmation("")}}><option value="TENANT">{t("tenant.privacy.scope.tenant")}</option><option value="ZAMMAD_TICKET">{t("tenant.privacy.scope.case")}</option><option value="REFERENCE">{t("tenant.privacy.scope.reference")}</option><option value="PARTICIPANT">{t("tenant.privacy.scope.participant")}</option><option value="ZAMMAD_USER">{t("tenant.privacy.scope.user")}</option></select></label>{needsValue?<PrivacyScopeTarget scopeType={scopeType} scopeValue={scopeValue} target={target} disabled={saving} hold={false} change={value=>{target.clear();setScopeValue(value);setError(null);setConfirmation("")}}/>:null}</div>{isExport?<div className="privacy-export-contract"><span>⌁</span><p><b>{t("tenant.privacy.requestDialog.exportLimits")}</b><small>{t("tenant.privacy.requestDialog.exportLimitsBody")}</small></p></div>:<><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.requestDialog.irreversible")}</b><small>{t("tenant.privacy.requestDialog.irreversibleBody")}</small></p></div><label className="privacy-confirm-input">{t("tenant.privacy.requestDialog.typeToConfirm")} <code dir="ltr"><bdi>{phrase}</bdi></code><input disabled={saving} aria-label={t("tenant.privacy.requestDialog.confirmationAria",{phrase})} autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)} spellCheck={false}/></label></>}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className={requestType==="DELETE"?"button connection-detail-danger-button":"button primary"} disabled={!valid||saving}>{saving?t("tenant.privacy.action.submitting"):t(isExport?"tenant.privacy.action.requestExport":"tenant.privacy.action.permanentDelete")}</button></div></form></ModalDialog>
}

function PrivacyRetryDialog({request,busy,close,retry}:{request:PrivacyRequest;busy:boolean;close:()=>void;retry:(confirmation:string|undefined,idempotencyKey:string)=>Promise<void>}){const {t}=useI18n();const [confirmation,setConfirmation]=useState("");const [idempotencyKey]=useState(()=>crypto.randomUUID());const isDelete=request.request_type==="DELETE";const phrase=request.scope_type==="TENANT"?"DELETE TENANT DATA":"DELETE";return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-retry-title"><div className="modal privacy-confirm-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.retry.eyebrow")}</span><h2 id="privacy-retry-title">{t(isDelete?"tenant.privacy.retry.deleteTitle":"tenant.privacy.retry.exportTitle")}</h2><p>{t("tenant.privacy.retry.body")}</p></div><button aria-label={t("tenant.privacy.retry.cancelAria")} onClick={close}>×</button></div>{request.safe_error?<div className="settings-feedback error"><span>!</span><p>{t("tenant.errors.privacyReview")}</p></div>:null}{isDelete?<><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.retry.authRequired")}</b><small>{t("tenant.privacy.retry.authRequiredBody")}</small></p></div><label className="privacy-confirm-input">{t("tenant.privacy.requestDialog.typeToConfirm")} <code dir="ltr"><bdi>{phrase}</bdi></code><input aria-label={t("tenant.privacy.requestDialog.confirmationAria",{phrase})} value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off" spellCheck={false}/></label></>:<div className="privacy-export-contract"><span>↻</span><p><b>{t("tenant.privacy.retry.safeExport")}</b><small>{t("tenant.privacy.retry.safeExportBody")}</small></p></div>}<div className="modal-actions"><button className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className={isDelete?"button connection-detail-danger-button":"button primary"} disabled={busy||(isDelete&&confirmation!==phrase)} onClick={()=>void retry(isDelete?confirmation:undefined,idempotencyKey)}>{busy?t("tenant.privacy.action.scheduling"):t("tenant.privacy.action.retryRequest")}</button></div></div></ModalDialog>}

function PrivacyRequestDetail({id,close}:{id:string;close:()=>void}) {
  const {locale,t}=useI18n();const [detail,setDetail]=useState<PrivacyRequest|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);
  const load=useCallback(async()=>{setLoading(true);setError(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(id)}`,{cache:"no-store"});if(!response.ok)throw operatorLocalFailure(await apiError(response));setDetail(await response.json() as PrivacyRequest)}catch(loadError){setError(operatorFailureMessage(loadError, t("tenant.privacy.error.loadDetail")))}finally{setLoading(false)}},[id,t]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);
  const scopeNames:Record<string,string>={TENANT:t("tenant.privacy.scope.tenant"),ZAMMAD_TICKET:t("tenant.privacy.scope.case"),REFERENCE:t("tenant.privacy.scope.reference"),PARTICIPANT:t("tenant.privacy.scope.participant"),GROUP_BINDING:t("tenant.privacy.scope.group"),WHATSAPP_GROUP:t("tenant.privacy.scope.groupHistory"),ZAMMAD_USER:t("tenant.privacy.scope.user")};
  const requestNames:Record<string,string>={EXPORT:t("tenant.privacy.request.export"),DELETE:t("tenant.privacy.request.delete")};
  const stageNames:Record<string,string>={PENDING:t("tenant.privacy.stage.pending"),DISCOVER:t("tenant.privacy.stage.discovery"),DISCOVERY:t("tenant.privacy.stage.discovery"),WRITE_ARTIFACT:t("tenant.privacy.stage.writeArtifact"),COMPLETED:t("tenant.privacy.stage.completed")};
  const summaryNames:Record<string,string>={ticket_count:t("tenant.privacy.summary.ticketCount"),message_count:t("tenant.privacy.summary.messageCount"),byte_size:t("tenant.privacy.summary.byteSize"),targets_discovered:t("tenant.privacy.summary.targetsDiscovered"),metaCostSourcesPurged:t("cost.statement.financeSourcesPurged"),metaCostSourcesRetained:t("cost.statement.financeSourcesRetained"),metaCostRecordsPurged:t("cost.statement.financeRecordsPurged"),metaCostRecordsRetained:t("cost.statement.financeRecordsRetained")};
  const summaryEntries=Object.entries(detail?.summary??{}).filter(([key,value])=>key in summaryNames&&typeof value==="number"&&Number.isFinite(value));
  const retainedFinance=[detail?.summary?.metaCostSourcesRetained,detail?.summary?.metaCostRecordsRetained].some(value=>typeof value==="number"&&Number.isFinite(value)&&value>0);
  const financeReviewRequired=["FINANCE_SOURCE_REVIEW_REQUIRED","FINANCE_RETENTION_REVIEW_REQUIRED"].includes(detail?.error_code??"");
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-detail-title"><div className="modal privacy-detail-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.detail.eyebrow")}</span><h2 id="privacy-detail-title">{t("tenant.privacy.detail.title")}</h2><p>{t("tenant.privacy.detail.body")}</p></div><button aria-label={t("tenant.privacy.detail.closeAria")} onClick={close}>×</button></div>{loading?<div className="privacy-detail-loading" aria-busy="true"><p className="sr-only" role="status" aria-label={t("tenant.privacy.detail.loading")}>{t("tenant.privacy.detail.loading")}</p><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/></div>:error?<section className="settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.privacy.detail.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.privacy.common.tryAgain")}</button></div></section>:detail?<><dl className="privacy-detail-facts"><div><dt>{t("tenant.privacy.detail.type")}</dt><dd>{requestNames[detail.request_type]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.state")}</dt><dd><Status value={detail.state}/></dd></div><div><dt>{t("tenant.privacy.table.scope")}</dt><dd>{scopeNames[detail.scope_type]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.scopeValue")}</dt><dd className="mono"><bdi>{privacyScopeReadback(detail.scope_type,detail.scope_value,t)}</bdi></dd></div><div><dt>{t("tenant.privacy.detail.stage")}</dt><dd>{stageNames[String(detail.stage??"PENDING").toUpperCase()]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.attempts")}</dt><dd className="mono">{formatNumber(detail.attempts??0,locale)} / {formatNumber(detail.max_attempts??8,locale)}</dd></div><div><dt>{t("tenant.privacy.detail.created")}</dt><dd>{exactTime(detail.created_at,locale,t("tenant.time.invalid"))}</dd></div><div><dt>{t("tenant.privacy.table.updated")}</dt><dd>{exactTime(detail.updated_at,locale,t("tenant.time.invalid"))}</dd></div></dl>{detail.safe_error?<div className="settings-feedback error"><span>!</span><p>{t(financeReviewRequired?"cost.statement.financePrivacyReview":"tenant.errors.privacyReview")}</p></div>:null}<div className="privacy-detail-summary"><b>{t("tenant.privacy.detail.summary")}</b>{retainedFinance?<p>{t("cost.statement.financePrivacyRetained")}</p>:null}{summaryEntries.length?<dl>{summaryEntries.map(([key,value])=><div key={key}><dt>{summaryNames[key]}</dt><dd className="mono">{key==="byte_size"?formatBytes(value as number,locale):formatNumber(value as number,locale)}</dd></div>)}</dl>:<p>{t("tenant.privacy.detail.noSummary")}</p>}</div></>:null}<div className="modal-actions"><button className="button secondary" onClick={close}>{t("tenant.privacy.action.close")}</button></div></div></ModalDialog>
}

function formatBytes(value:number|null,locale:"en"|"ar"){if(value==null)return"—";const units=["byte","kilobyte","megabyte"] as const;const unitIndex=value<1024?0:value<1024*1024?1:2;return formatNumber(value/1024**unitIndex,locale,{style:"unit",unit:units[unitIndex],unitDisplay:"short",maximumFractionDigits:unitIndex?1:0})}
