"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import type { RuleMatch, TriggerRule } from "../lib/domain";
import { describeRuleChange } from "../lib/rule-version-diff";
import { useI18n } from "./I18nProvider";
import { MarketingIcon } from "./MarketingIcon";
import { formatNumber } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { type RecordRow, type TenantTranslator, apiError, Status, Empty } from "./tenant-ui";

const hasBotActionCapability = (row: RecordRow, surface: string) => {
  const capabilities = row.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const surfaces = (capabilities as RecordRow).invocation_surfaces;
  return Array.isArray(surfaces) && surfaces.includes(surface);
};

function idempotentHeaders(headers:Record<string,string>){return{...headers,"idempotency-key":crypto.randomUUID()}}

export function Rules({
  rows,
  groups,
  onSaved,
  mutationHeaders,
  canCreate,
}: {
  rows: TriggerRule[];
  groups: RecordRow[];
  onSaved: () => void;
  mutationHeaders: Record<string, string>;
  canCreate: boolean;
}) {
  const { locale, t } = useI18n();
  const [sample, setSample] = useState(
    t("tenant.rules.sample.default"),
  );
  const [result, setResult] = useState<{
    normalized: string;
    matches: RuleMatch[];
    warnings?: Array<{ code?: string }>;
  } | null>(null);
  const [testGroupId, setTestGroupId] = useState(() => String(groups[0]?.id ?? ""));
  const [testSender,setTestSender]=useState<"customer"|"team"|"unknown">("customer");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRule, setSelectedRule] = useState<TriggerRule | null>(null);
  const [additionalRuleGroups, setAdditionalRuleGroups] = useState<RecordRow[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupLoadError, setGroupLoadError] = useState<string | null>(null);
  const [loadedPageHasMore, setLoadedPageHasMore] = useState<boolean | null>(null);
  const testOutput = useRef<HTMLDivElement>(null);
  const ruleGroups = [...new Map([...groups, ...additionalRuleGroups].map((group) => [String(group.id), group])).values()];
  const canLoadMoreGroups = loadedPageHasMore ?? groups.length === 200;
  const testGroup = ruleGroups.find((group) => String(group.id) === testGroupId) ?? ruleGroups[0];
  const testGroupNameCounts = new Map<string, number>();
  for (const group of ruleGroups) {
    const name = String(group.name ?? group.display_name ?? t("tenant.rules.tester.defaultGroup"));
    testGroupNameCounts.set(name, (testGroupNameCounts.get(name) ?? 0) + 1);
  }
  const configuredLimit = Number(testGroup?.max_identifiers ?? 20);
  const maxIdentifiers = Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 100 ? configuredLimit : 20;
  const limitExceeded = Boolean(result && result.matches.length > maxIdentifiers);
  const warningCodes = [...new Set((result?.warnings ?? []).map((warning) => String(warning.code ?? "")).filter((code) => ["OVERLAPPING_RULES", "BROAD_MATCH", "MATCH_LIMIT_REACHED", "TEAM_SENDER_EXCLUDED"].includes(code)))];
  const loadMoreGroups = async () => {
    const after = String(ruleGroups.at(-1)?.id ?? "");
    if (!after || loadingGroups) return;
    setLoadingGroups(true); setGroupLoadError(null);
    try {
      const response = await fetch(`/api/groups?limit=200&after=${encodeURIComponent(after)}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as RecordRow[];
      setAdditionalRuleGroups((current) => [...new Map([...current, ...next].map((group) => [String(group.id), group])).values()]);
      setLoadedPageHasMore(next.length === 200);
    } catch (problem) {
      setGroupLoadError(operatorFailureMessage(problem, t("tenant.rules.tester.groupLoadFailed")));
    } finally { setLoadingGroups(false); }
  };
  const run = async () => {
    if (!rows.length) return;
    setTesting(true);
    setTestError(null);
    try {
      const r = await fetch("/api/rules/test", {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify({ message: sample, sender:testSender, rules: rows }),
      });
      if (!r.ok) throw operatorLocalFailure(await apiError(r));
      setResult(await r.json());
    } catch (problem) {
      setResult(null);
      setTestError(operatorFailureMessage(problem, t("tenant.rules.errors.test")));
    } finally {
      setTesting(false);
      window.requestAnimationFrame(() => testOutput.current?.focus({ preventScroll: true }));
    }
  };
  return (
    <div className="rules-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t(rows.length ? "tenant.rules.activeSet" : "tenant.rules.noActiveSet")}</h2>
            <p>{rows.length ? <>{t("tenant.rules.governedVersion")} <bdi>{formatNumber(Number(rows[0]?.version ?? 0), locale)}</bdi></> : t("tenant.rules.noActiveSetBody")}</p>
          </div>
          {canCreate && <button className="button icon-action" onClick={() => setCreating(true)}><MarketingIcon name="plus" />{t("tenant.rules.new")}</button>}
        </div>
        <div className="rule-list">
          {rows.map((rule) => (
            <div className="rule-card" key={rule.id}>
              <div className="drag">⠿</div>
              <div className="rule-index">{formatNumber(rule.priority, locale)}</div>
              <div className="rule-info">
                <div>
                  <b><bdi>{rule.name}</bdi></b>
                  <Status value={rule.enabled ? "Active" : "Paused"} />
                </div>
                <small className="rule-matcher-summary">{t(`tenant.rules.matcher.${rule.matcherType}`)}</small>
                <small>
                  {t("tenant.rules.versionShort")}<bdi>{formatNumber(rule.version, locale)}</bdi> · <bdi>{formatNumber(rule.matchCount, locale)}</bdi> {t(rule.matchCount === 1 ? "tenant.rules.matches.one" : "tenant.rules.matches")}
                </small>
              </div>
              <button className="more" aria-label={t("tenant.rules.inspectNamed", { name: rule.name })} onClick={() => setSelectedRule(rule)}>•••</button>
            </div>
          ))}
        </div>
        <div className="panel-footer">
          <span>
            {t("tenant.rules.priorityHelp")}
          </span>
          <button className="text-button" onClick={() => setHistoryOpen(true)}>{t("tenant.rules.compareVersions")}</button>
        </div>
      </section>
      <section className="panel tester">
        <div className="panel-heading">
          <div>
            <h2>{t("tenant.rules.tester.title")}</h2>
            <p>{t("tenant.rules.tester.body")}</p>
          </div>
        </div>
        <label htmlFor="rule-test-sender">{t("tenant.rules.tester.sender")}<select id="rule-test-sender" value={testSender} onChange={event=>{setTestSender(event.target.value as "customer"|"team"|"unknown");setResult(null);setTestError(null)}}><option value="customer">{t("tenant.rules.tester.sender.customer")}</option><option value="team">{t("tenant.rules.tester.sender.team")}</option><option value="unknown">{t("tenant.rules.tester.sender.unknown")}</option></select></label>
        <label htmlFor="rule-test-sample">
          <span id="rule-test-sample-label">{t("tenant.rules.tester.sampleLabel")}</span>
          <textarea
            id="rule-test-sample"
            aria-labelledby="rule-test-sample-label"
            value={sample}
            onChange={(e) => { setSample(e.target.value); setResult(null); setTestError(null); }}
            rows={5}
          />
        </label>
        {ruleGroups.length ? <label>{t("tenant.rules.tester.groupLabel")}<select value={String(testGroup?.id ?? "")} onChange={(event) => { setTestGroupId(event.target.value); setResult(null); }}>{ruleGroups.map((group) => { const name=String(group.name??group.display_name??t("tenant.rules.tester.defaultGroup"));return <option dir="auto" key={String(group.id)} value={String(group.id)}>{(testGroupNameCounts.get(name)??0)>1?t(group.members===null?"tenant.rules.tester.groupOptionDetailedUnknown":"tenant.rules.tester.groupOptionDetailed",{name,connection:String(group.connection_name??t("tenant.rules.tester.unknownConnection")),members:group.members===null?"":formatNumber(Number(group.members??0),locale)}):name}</option> })}</select><small>{t("tenant.rules.tester.groupLimit", { limit: formatNumber(maxIdentifiers, locale) })}</small>{canLoadMoreGroups?<button type="button" className="text-button" disabled={loadingGroups} onClick={()=>void loadMoreGroups()}>{t(loadingGroups?"tenant.rules.tester.loadingGroups":"tenant.rules.tester.loadMoreGroups")}</button>:null}{groupLoadError?<small role="alert" className="bot-inline-error">{groupLoadError}</small>:null}</label> : null}
        <div className="tester-actions">
          <button className="button primary" onClick={run} disabled={testing || !rows.length} aria-controls="rule-test-output">
            {t(testing ? "tenant.rules.actions.testing" : "tenant.rules.actions.runTest")}
          </button>
          <span>{t("tenant.rules.tester.digitHelp")}</span>
        </div>
        <div id="rule-test-output" className="rule-test-output" ref={testOutput} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {!rows.length ? (
          <div className="test-placeholder">
            <p>{t("tenant.rules.tester.noRules")}</p>
            {canCreate ? <button className="button small" onClick={() => setCreating(true)}>{t("tenant.rules.new")}</button> : null}
          </div>
        ) : null}
        {rows.length && testError ? <div className="settings-feedback error rule-test-feedback" role="alert"><span>!</span><p>{testError}</p></div> : null}
        {rows.length && !testError && result ? (
          <div className="test-result">
            <div className={`result-head ${limitExceeded ? "warning" : ""}`}>
              <span className="health-icon">{limitExceeded ? "!" : "✓"}</span>
              <span>
                <b>{t(`tenant.rules.tester.references.${countForm(result.matches.length)}`, { count: formatNumber(result.matches.length, locale) })}</b>
                <small>
                  {limitExceeded ? t("tenant.rules.tester.limitExceeded", { limit: formatNumber(maxIdentifiers, locale) }) : t(`tenant.rules.tester.supportCases.${countForm(result.matches.length)}`, { count: formatNumber(result.matches.length, locale) })}
                </small>
              </span>
            </div>
            {warningCodes.length ? <ul className="rule-test-warnings">{warningCodes.map((code) => <li key={code}>{t(`tenant.rules.tester.warning.${code}`)}</li>)}</ul> : null}
            <div className="normalized">
              <small>{t("tenant.rules.normalizedInput")}</small>
              <code><bdi>{result.normalized}</bdi></code>
            </div>
            {result.matches.map((m) => (
              <div className="match" key={`${m.ruleId}-${m.start}`}>
                <span><bdi>{m.normalizedValue}</bdi></span>
                <small><bdi>{m.ruleName}</bdi></small>
              </div>
            ))}
          </div>
        ) : rows.length ? (
          <div className="test-placeholder">
            {t("tenant.rules.tester.placeholder")}
          </div>
        ) : null}
        </div>
      </section>
      {creating && canCreate && (
        <RuleModal
          mutationHeaders={mutationHeaders}
          close={() => setCreating(false)}
          saved={() => {
            setCreating(false);
            setHistoryOpen(true);
            onSaved();
          }}
        />
      )}
      {selectedRule ? <ModalDialog close={() => setSelectedRule(null)} className="modal-backdrop" aria-labelledby="rule-inspector-title"><div className="modal rule-inspector"><div className="modal-head"><div><span className="eyebrow">{t("tenant.rules.inspector.eyebrow")}</span><h2 id="rule-inspector-title"><bdi>{selectedRule.name}</bdi></h2><p>{t("tenant.rules.inspector.body")}</p></div><button aria-label={t("tenant.rules.inspector.close")} onClick={() => setSelectedRule(null)}>×</button></div><dl className="rule-inspector-facts"><div><dt>{t("tenant.rules.matcher")}</dt><dd>{t(`tenant.rules.matcher.${selectedRule.matcherType}`)}</dd></div><div><dt>{t("tenant.rules.priority")}</dt><dd>{formatNumber(selectedRule.priority, locale)}</dd></div><div><dt>{t("tenant.rules.version")}</dt><dd>{t("tenant.rules.versionShort")}<bdi>{formatNumber(selectedRule.version, locale)}</bdi></dd></div><div><dt>{t("tenant.rules.state")}</dt><dd>{t(selectedRule.enabled ? "common.status.active" : "tenant.status.paused")}</dd></div></dl><RuleMatcherCondition rule={selectedRule} locale={locale} t={t} /><div className="modal-actions"><button className="button secondary" onClick={() => setSelectedRule(null)}>{t("tenant.rules.actions.close")}</button><button className="button primary" onClick={() => { const example = selectedRule.matcherType === "exact_length" ? "1".repeat(selectedRule.digitLength ?? 10) : selectedRule.matcherType === "prefix_length" ? `${selectedRule.prefix ?? "ABC"}${"1".repeat(selectedRule.digitLength ?? 7)}` : selectedRule.matcherType === "advanced" ? null : selectedRule.pattern; setSample(example ? t("tenant.rules.sample.investigate", { example }) : t("tenant.rules.sample.default")); setResult(null); setTestError(null); setSelectedRule(null); }}>{t("tenant.rules.actions.useInTester")}</button></div></div></ModalDialog> : null}
      {historyOpen ? <RuleGovernanceDialog canManage={canCreate} mutationHeaders={mutationHeaders} close={() => setHistoryOpen(false)} changed={onSaved} /> : null}
    </div>
  );
}

function RuleMatcherCondition({ rule, locale, t }: { rule: TriggerRule; locale: "en" | "ar"; t: TenantTranslator }) {
  if (rule.matcherType === "advanced") return <details className="rule-expression-details"><summary>{t("tenant.rules.advancedDetails")}</summary><div className="normalized"><small>{t("tenant.rules.expression")}</small><code><bdi>{rule.pattern}</bdi></code></div></details>;
  const hasDigitLength = rule.matcherType === "exact_length" || rule.matcherType === "prefix_length";
  return <div className="normalized">
    <small>{t("tenant.rules.condition")}</small>
    {hasDigitLength ? <>
      {rule.matcherType === "prefix_length" ? <div><b>{t("tenant.rules.modal.prefix")}: </b><code><bdi dir="auto">{rule.prefix || t("tenant.rules.inspector.notConfigured")}</bdi></code></div> : null}
      <div><b>{t("tenant.rules.modal.digitLength")}: </b><bdi>{rule.digitLength == null ? t("tenant.rules.inspector.notConfigured") : formatNumber(rule.digitLength, locale)}</bdi></div>
    </> : <code><bdi dir="auto">{rule.pattern}</bdi></code>}
  </div>;
}

type RuleSetVersionRow = RecordRow & {
  id: string;
  family_id?: string;
  familyId?: string;
  name: string;
  version: number;
  state: "DRAFT" | "ACTIVE" | "RETIRED";
  revision: number;
  rules?: RecordRow[];
};

function ruleReadinessIssue(value: unknown, t: TenantTranslator) {
  const key = ({
    NO_ENABLED_RULES: "tenant.rules.readiness.issue.noEnabledRules",
    DUPLICATE_MATCHER: "tenant.rules.readiness.issue.duplicateMatcher",
    NO_SAVED_EXAMPLES: "tenant.rules.readiness.issue.noSavedExamples",
    INVALID_SAVED_EXAMPLE: "tenant.rules.readiness.issue.invalidSavedExample",
    SAVED_EXAMPLE_MISMATCH: "tenant.rules.readiness.issue.savedExampleMismatch",
    OVERLAPPING_RULES: "tenant.rules.readiness.issue.overlappingRules",
    BROAD_MATCH: "tenant.rules.readiness.issue.broadMatch",
    MATCH_LIMIT_REACHED: "tenant.rules.readiness.issue.matchLimitReached",
  } as Record<string, string>)[String(value)] ?? "tenant.rules.readiness.issue.unknown";
  return t(key);
}

function RuleGovernanceDialog({
  canManage,
  mutationHeaders,
  close,
  changed,
}: {
  canManage: boolean;
  mutationHeaders: Record<string, string>;
  close: () => void;
  changed: () => void;
}) {
  const { locale, t } = useI18n();
  const [versions, setVersions] = useState<RuleSetVersionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder,setLoadingOlder]=useState(false);
  const [canLoadOlder,setCanLoadOlder]=useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [comparison, setComparison] = useState<RecordRow | null>(null);
  const [comparing, setComparing] = useState(false);
  const [operation, setOperation] = useState<{ kind: "activate" | "rollback"; target: RuleSetVersionRow } | null>(null);
  const [clonePolicies,setClonePolicies]=useState<Record<string,"include"|"exclude">>({});
  const cloneRequest = useRef<{ sourceId: string; key: string; pending: boolean; body: string } | null>(null);
  const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<RecordRow | null>(null);
  const [operating, setOperating] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const readinessTarget = useRef<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/rule-sets?limit=200", { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const value = await response.json() as RuleSetVersionRow[];
      setVersions(value);
      setCanLoadOlder(value.length===200);
      const active = value.find((item) => item.state === "ACTIVE");
      const family = active ? ruleSetFamily(active) : value[0] ? ruleSetFamily(value[0]) : "";
      const prior = value.find((item) => item.state === "RETIRED" && ruleSetFamily(item) === family);
      const draft = value.find((item) => item.state === "DRAFT" && ruleSetFamily(item) === family);
      setLeftId((current) => value.some((item) => item.id === current) ? current : (prior ?? draft ?? active)?.id ?? "");
      setRightId((current) => value.some((item) => item.id === current) ? current : active?.id ?? draft?.id ?? "");
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.versionsLoad")));
    } finally {
      setLoading(false);
    }
  }, [t]);
  const loadOlder=async()=>{
    const before=versions?.at(-1)?.id;if(!before||loadingOlder)return;setLoadingOlder(true);setError(null);
    try{const response=await fetch(`/api/rule-sets?limit=200&before=${encodeURIComponent(before)}`,{cache:"no-store"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as RuleSetVersionRow[];setVersions(current=>[...(current??[]),...next.filter(item=>!current?.some(existing=>existing.id===item.id))]);setCanLoadOlder(next.length===200)}
    catch(problem){setError(operatorFailureMessage(problem, t("tenant.rules.errors.versionsLoad")))}finally{setLoadingOlder(false)}
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const compare = async () => {
    if (!leftId || !rightId || comparing) return;
    setComparing(true);
    setError(null);
    setComparison(null);
    try {
      const response = await fetch(`/api/rule-sets/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setComparison(await response.json() as RecordRow);
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.compare")));
    } finally {
      setComparing(false);
    }
  };
  const prepare = async (kind: "activate" | "rollback", target: RuleSetVersionRow) => {
    if (operating || cloneRequest.current?.pending) return;
    setError(null);
    setReadiness(null);
    setConfirmation("");
    readinessTarget.current = target.id;
    setOperation({ kind, target });
    try {
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(target.id)}/readiness`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as RecordRow;
      // Ignore a readiness answer for a version the operator has already moved away from.
      if (readinessTarget.current === target.id) setReadiness(next);
    } catch (problem) {
      if (readinessTarget.current !== target.id) return;
      setOperation(null);
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.readiness")));
    }
  };
  const execute = async () => {
    if (!operation || operating || readiness?.ready !== true) return;
    const active = versions?.find((item) => item.state === "ACTIVE" && ruleSetFamily(item) === ruleSetFamily(operation.target));
    setOperating(true);
    setError(null);
    try {
      const body = operation.kind === "activate"
        ? { expectedRevision: Number(operation.target.revision), expectedActiveRuleSetId: active?.id ?? null, expectedActiveRevision: active ? Number(active.revision) : null }
        : { expectedSourceRevision: Number(operation.target.revision), expectedActiveRuleSetId: active?.id ?? null, expectedActiveRevision: active ? Number(active.revision) : null };
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(operation.target.id)}/${operation.kind}`, {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setNotice(t(operation.kind === "activate" ? "tenant.rules.notice.activated" : "tenant.rules.notice.restored", { version: formatNumber(operation.target.version, locale) }));
      setOperation(null);
      setReadiness(null);
      await load();
      changed();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.operation")));
    } finally {
      setOperating(false);
    }
  };
  const cloneVersion = async (target: RuleSetVersionRow) => {
    if (operating || cloneRequest.current?.pending) return;
    if (cloneRequest.current && cloneRequest.current.sourceId !== target.id) return;
    const rules=(target.rules??[]).map((rule,index)=>({name:rule.name,matcherType:rule.matcherType,pattern:rule.pattern,matcherOptions:{...(rule.matcherOptions as Record<string,unknown>??{}),teamSenderPolicy:clonePolicies[`${target.id}:${index}`]??(rule.matcherOptions as Record<string,unknown>|undefined)?.teamSenderPolicy??"include"},priority:rule.priority,enabled:rule.enabled,savedExamples:rule.savedExamples}));
    const request = cloneRequest.current ?? { sourceId: target.id, key: crypto.randomUUID(), pending: false, body: JSON.stringify({rules}) };
    cloneRequest.current = request;
    setCloneSourceId(request.sourceId);
    request.pending = true;
    setOperating(true);setError(null);
    let rejected = false;
    try {
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(target.id)}/clone`, {
        method: "POST", headers: { ...mutationHeaders, "idempotency-key": request.key }, body: request.body,
      });
      if (!response.ok) { rejected = response.status < 500; throw operatorLocalFailure(await apiError(response)); }
      const result = await response.json() as { resultId: string };
      cloneRequest.current = null;
      setCloneSourceId(null);
      setNotice(t("tenant.rules.notice.cloned"));setLeftId(result.resultId);
      await load();changed();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("common.errors.network")));
      // A definite rejection releases the other clone actions; an unknown outcome keeps the retry key.
      if (rejected) { cloneRequest.current = null; setCloneSourceId(null); }
    } finally {
      request.pending = false;setOperating(false);
    }
  };
  const items = versions ?? [];
  const left = items.find((item) => item.id === leftId);
  const comparable = left ? items.filter((item) => ruleSetFamily(item) === ruleSetFamily(left) && item.id !== left.id) : items;
  const changes = Array.isArray(comparison?.changes) ? comparison.changes as RecordRow[] : [];
  const presentedChanges = changes.map((change) => {
    const fields = change.kind === "CHANGED" ? describeRuleChange(change) : [];
    return {
      change,
      fields,
      kind: change.kind === "CHANGED" && fields.length === 0 ? "UNCHANGED" : String(change.kind),
    };
  });
  const comparisonSummary = {
    added: presentedChanges.filter((change) => change.kind === "ADDED").length,
    removed: presentedChanges.filter((change) => change.kind === "REMOVED").length,
    changed: presentedChanges.filter((change) => change.kind === "CHANGED").length,
    unchanged: presentedChanges.filter((change) => change.kind === "UNCHANGED").length,
  };
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers as RecordRow[] : [];
  const warnings = Array.isArray(readiness?.warnings) ? readiness.warnings as RecordRow[] : [];
  return <ModalDialog close={operating ? () => {} : close} className="modal-backdrop" aria-labelledby="rule-history-title"><div className="modal rule-governance-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.rules.governance.eyebrow")}</span><h2 id="rule-history-title">{t("tenant.rules.governance.title")}</h2><p>{t("tenant.rules.governance.body")}</p></div><button disabled={operating} aria-label={t("tenant.rules.governance.close")} onClick={close}>×</button></div>
    {notice ? <div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div> : null}
    {error ? <div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{versions === null ? <button className="button small" disabled={loading} onClick={() => void load()}>{t("common.actions.retry")}</button> : <button className="text-button" onClick={() => setError(null)}>{t("tenant.rules.actions.dismiss")}</button>}</div> : null}
    {loading && versions === null ? <div className="review-loading" role="status"><span /><span /><b>{t("tenant.rules.governance.loading")}</b></div> : error && versions === null ? null : items.length ? <div className="rule-governance-body">
      <section className="rule-version-list" aria-labelledby="version-list-heading"><div className="connection-detail-section-head"><div><h3 id="version-list-heading">{t("tenant.rules.governance.history")}</h3><p>{t("tenant.rules.governance.historyBody")}</p></div><button className="button small secondary" disabled={loading} onClick={() => void load()}>{t(loading ? "tenant.rules.actions.refreshing" : "tenant.rules.actions.refresh")}</button></div>{items.map((item) => <article key={item.id}><span className="rule-version-number">{t("tenant.rules.versionShort")}<bdi>{formatNumber(item.version, locale)}</bdi></span><span><b><bdi>{item.name}</bdi></b><small><bdi>{formatNumber(Array.isArray(item.rules) ? item.rules.length : 0, locale)}</bdi> {t("tenant.rules.rulesCountLabel")} · {t("tenant.rules.revision")} <bdi>{formatNumber(item.revision, locale)}</bdi></small></span><Status value={item.state} /><span className="rule-version-actions">{canManage?(item.rules??[]).map((rule,index)=><label key={`${item.id}:${index}`}>{String(rule.name)} — {t("tenant.rules.teamPolicy")}<select disabled={operating||cloneSourceId!==null} value={clonePolicies[`${item.id}:${index}`]??String((rule.matcherOptions as Record<string,unknown>|undefined)?.teamSenderPolicy??"include")} onChange={event=>setClonePolicies(current=>({...current,[`${item.id}:${index}`]:event.target.value as "include"|"exclude"}))}><option value="include">{t("tenant.rules.teamPolicy.include")}</option><option value="exclude">{t("tenant.rules.teamPolicy.exclude")}</option></select></label>):null}{canManage ? <button className="button small secondary" disabled={operating || Boolean(cloneSourceId && cloneSourceId !== item.id)} onClick={() => void cloneVersion(item)}>{t(operating && cloneSourceId === item.id ? "tenant.rules.actions.recording" : "tenant.rules.actions.clone")}</button> : null}<button className="text-button" onClick={() => { setLeftId(item.id); setComparison(null); setRightId((current) => { const right = items.find((other) => other.id === current); return right && right.id !== item.id && ruleSetFamily(right) === ruleSetFamily(item) ? current : items.find((other) => other.id !== item.id && ruleSetFamily(other) === ruleSetFamily(item))?.id ?? ""; }); }}>{t("tenant.rules.actions.compare")}</button>{canManage && item.state === "DRAFT" ? <button className="button small" onClick={() => void prepare("activate", item)}>{t("tenant.rules.actions.activateEllipsis")}</button> : null}{canManage && item.state === "RETIRED" ? <button className="button small secondary" onClick={() => void prepare("rollback", item)}>{t("tenant.rules.actions.rollbackEllipsis")}</button> : null}</span></article>)}{canLoadOlder?<div className="audit-pagination"><button className="button secondary" disabled={loadingOlder} onClick={()=>void loadOlder()}>{t(loadingOlder?"tenant.rules.governance.loadingOlder":"tenant.rules.governance.loadOlder")}</button></div>:null}</section>
      <section className="rule-compare-panel" aria-labelledby="rule-compare-heading"><div className="connection-detail-section-head"><div><h3 id="rule-compare-heading">{t("tenant.rules.comparison.title")}</h3><p>{t("tenant.rules.comparison.body")}</p></div></div><div className="rule-compare-selectors"><label>{t("tenant.rules.comparison.from")}<select value={leftId} onChange={(event) => { setLeftId(event.target.value); setComparison(null); const selected = items.find((item) => item.id === event.target.value); const candidate = items.find((item) => selected && ruleSetFamily(item) === ruleSetFamily(selected) && item.id !== selected.id); setRightId(candidate?.id ?? ""); }}>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span><label>{t("tenant.rules.comparison.to")}<select value={rightId} onChange={(event) => { setRightId(event.target.value); setComparison(null); }}>{comparable.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><button className="button primary" disabled={!leftId || !rightId || leftId === rightId || comparing} onClick={() => void compare()}>{t(comparing ? "tenant.rules.actions.comparing" : "tenant.rules.actions.compare")}</button></div>{comparison ? <div className="rule-comparison-result"><div className="rule-comparison-summary"><span><b>{formatNumber(comparisonSummary.added, locale)}</b><small>{t("tenant.rules.comparison.added")}</small></span><span><b>{formatNumber(comparisonSummary.removed, locale)}</b><small>{t("tenant.rules.comparison.removed")}</small></span><span><b>{formatNumber(comparisonSummary.changed, locale)}</b><small>{t("tenant.rules.comparison.changed")}</small></span><span><b>{formatNumber(comparisonSummary.unchanged, locale)}</b><small>{t("tenant.rules.comparison.unchanged")}</small></span></div><div className="rule-change-list">{presentedChanges.map(({ change, fields, kind }, index) => <div key={`${String(change.name)}-${index}`}><Status value={kind} /><span><b><bdi>{String(change.name)}</bdi></b>{kind === "CHANGED" ? <ul className="rule-change-evidence" aria-label={t("tenant.rules.comparison.changedFields", { name: String(change.name) })}>{fields.map((field) => <li key={field.key}><bdi>{field.summary}</bdi></li>)}</ul> : <small>{t(kind === "UNCHANGED" && change.kind === "CHANGED" ? "tenant.rules.comparison.noMaterialChanges" : `tenant.rules.change.${kind.toLowerCase()}`)}</small>}</span></div>)}</div></div> : <div className="rule-history-empty"><span>◇</span><div><b>{t("tenant.rules.comparison.selectTwo")}</b><p>{t("tenant.rules.comparison.readOnly")}</p></div></div>}</section>
      {operation ? <InlineConfirmation busy={operating} className={`rule-operation-confirm ${operation.kind}`} aria-labelledby="rule-operation-title" cancel={() => { setOperation(null); setReadiness(null); setConfirmation(""); }}><div><span className="eyebrow">{t(operation.kind === "activate" ? "tenant.rules.operation.activation" : "tenant.rules.operation.rollback")}</span><h3 id="rule-operation-title">{t(operation.kind === "activate" ? "tenant.rules.operation.activateTitle" : "tenant.rules.operation.restoreTitle", { version: formatNumber(operation.target.version, locale) })}</h3><p>{t(operation.kind === "activate" ? "tenant.rules.operation.activateBody" : "tenant.rules.operation.restoreBody")}</p></div>{readiness ? <div className={`rule-readiness ${readiness.ready === true ? "ready" : "blocked"}`}><span>{readiness.ready === true ? "✓" : "!"}</span><div><b>{t(readiness.ready === true ? "tenant.rules.readiness.passed" : "tenant.rules.readiness.blocked")}</b><small><bdi>{formatNumber(Number(readiness.enabledRuleCount ?? 0), locale)}</bdi> {t("tenant.rules.readiness.enabledRules")} · <bdi>{formatNumber(Number(readiness.checkedExamples ?? 0), locale)}</bdi> {t("tenant.rules.readiness.examplesChecked")}</small></div></div> : <div className="review-loading compact" role="status"><span /><b>{t("tenant.rules.readiness.checking")}</b></div>}{blockers.length ? <ul className="rule-issue-list blockers">{blockers.map((item, index) => <li key={`${String(item.code)}-${index}`}><b>{ruleReadinessIssue(item.code, t)}</b></li>)}</ul> : null}{warnings.length ? <ul className="rule-issue-list warnings">{warnings.map((item, index) => <li key={`${String(item.code)}-${index}`}><b>{ruleReadinessIssue(item.code, t)}</b></li>)}</ul> : null}{operation.kind === "rollback" ? <label className="rule-rollback-confirmation">{t("tenant.rules.operation.typeRollback")} <code>{t("tenant.rules.operation.rollbackConfirmation")}</code> {t("tenant.rules.operation.typeRollbackSuffix")}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label> : null}<div className="modal-actions"><button className="button secondary" data-inline-confirm-initial-focus disabled={operating} onClick={() => { setOperation(null); setReadiness(null); setConfirmation(""); }}>{t("tenant.rules.actions.cancel")}</button><button className={operation.kind === "activate" ? "button primary" : "button connection-detail-danger-button"} disabled={operating || readiness?.ready !== true || (operation.kind === "rollback" && confirmation !== "ROLLBACK")} onClick={() => void execute()}>{t(operating ? "tenant.rules.actions.recording" : operation.kind === "activate" ? "tenant.rules.actions.activateVersion" : "tenant.rules.actions.createRollback")}</button></div></InlineConfirmation> : null}
    </div> : <Empty title={t("tenant.rules.empty.title")} body={t("tenant.rules.empty.body")} />}
  </div></ModalDialog>;
}

function ruleSetFamily(item: RuleSetVersionRow) {
  return String(item.family_id ?? item.familyId ?? "");
}

function RuleModal({
  close,
  saved,
  mutationHeaders,
}: {
  close: () => void;
  saved: () => void;
  mutationHeaders: Record<string, string>;
}) {
  const { t } = useI18n();
  const id = useId();
  const saveKey = useRef<{ body: string; key: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    matcherType: "exact_length" as TriggerRule["matcherType"],
    pattern: "",
    prefix: "",
    digitLength: 10,
    teamSenderPolicy: "include" as "include" | "exclude",
    groupCommand: false,
    actionId: "",
    successReply: t("tenant.rules.command.successDefault"),
    failureReply: t("tenant.rules.command.failureDefault"),
  });
  const [commandInputs,setCommandInputs]=useState([{key:"query",value:"{{message.argument}}"}]);
  const [commandActions,setCommandActions]=useState<Array<{action_key:string;name:string}>>([]);
  const [sample, setSample] = useState(t("tenant.rules.modal.sampleDefault"));
  const [testedSignature, setTestedSignature] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ normalized?: string; matches?: RuleMatch[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidatePattern = form.matcherType === "exact_length"
    ? `(?<!\\d)\\d{${form.digitLength}}(?!\\d)`
    : form.matcherType === "prefix_length"
      ? `\\b${form.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\d{${form.digitLength}}\\b`
      : form.pattern;
  const candidate = {
    id: "candidate-rule",
    name: form.name.trim(),
    teamSenderPolicy: form.teamSenderPolicy,
    matcherType: form.matcherType,
    pattern: candidatePattern,
    prefix: form.matcherType === "prefix_length" ? form.prefix.trim() : null,
    digitLength: ["exact_length", "prefix_length"].includes(form.matcherType) ? Number(form.digitLength) : null,
    priority: 10,
    enabled: true,
    matchCount: 0,
    version: 1,
    ...(form.groupCommand?{groupCommand:{actionId:form.actionId,input:Object.fromEntries(commandInputs.filter(row=>row.key.trim()).map(row=>[row.key.trim(),row.value])),successReply:form.successReply,failureReply:form.failureReply}}:{}),
  } satisfies TriggerRule;
  const signature = JSON.stringify({ candidate, sample });
  const safeTestCurrent = testedSignature === signature && Boolean(testResult?.matches?.length);
  const updateForm = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestedSignature(null);
    setTestResult(null);
    setError(null);
  };
  useEffect(()=>{if(!form.groupCommand)return;let active=true;void fetch("/api/bot-flows/actions",{cache:"no-store"}).then(async response=>{if(!response.ok)throw operatorLocalFailure(await apiError(response));return response.json() as Promise<Array<Record<string,unknown>>|{actions:Array<Record<string,unknown>>}>}).then(value=>{if(!active)return;const rows=Array.isArray(value)?value:value.actions??[];const actions=rows.filter(row=>row.state==="ACTIVE"&&hasBotActionCapability(row,"GROUP_COMMAND")).map(row=>({action_key:String(row.action_key),name:String(row.name)}));setCommandActions(actions);setForm(current=>current.actionId||!actions[0]?current:{...current,actionId:actions[0].action_key})}).catch(()=>{if(active)setError(t("tenant.rules.errors.actions"))});return()=>{active=false}},[form.groupCommand,t]);
  const testCandidate = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/rules/test", {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify({ message: sample, sender: "customer", rules: [candidate] }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = await response.json() as { normalized?: string; matches?: RuleMatch[] };
      if (!result.matches?.length) throw operatorLocalFailure(t("tenant.rules.errors.noReference"));
      setTestResult(result);
      setTestedSignature(signature);
    } catch (problem) {
      setTestedSignature(null);
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.safeTest")));
    } finally {
      setTesting(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !safeTestCurrent || saving) {
      setError(t("tenant.rules.errors.testBeforeSave"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({
        ...candidate,
        savedExamples: [{
          name: t("tenant.rules.modal.creationValidation"),
          message: sample,
          sender: "customer",
          expectedMatches: testResult?.matches?.map((match) => match.normalizedValue) ?? [],
        }],
      });
      // Retrying the same rule after a lost response reuses its key, so the server cannot create it twice.
      if (saveKey.current?.body !== body) saveKey.current = { body, key: crypto.randomUUID() };
      const r = await fetch("/api/rules", {
        method: "POST",
        headers: { ...mutationHeaders, "idempotency-key": saveKey.current.key },
        body,
      });
      if (!r.ok) throw operatorLocalFailure(await apiError(r));
      saveKey.current = null;
      saved();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.save")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalDialog
      close={close}
      className="modal-backdrop"
      aria-labelledby="create-rule-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t("tenant.rules.modal.eyebrow")}</span>
            <h2 id="create-rule-title">{t("tenant.rules.modal.title")}</h2>
            <p>{t("tenant.rules.modal.body")}</p>
          </div>
          <button type="button" aria-label={t("tenant.rules.modal.close")} onClick={close}>
            ×
          </button>
        </div>
        <label htmlFor={`${id}-name`}>
          {t("tenant.rules.modal.name")}
          <input
            id={`${id}-name`}
            required
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("tenant.rules.modal.namePlaceholder")}
          />
        </label>
        <label htmlFor={`${id}-matcher`}>
          {t("tenant.rules.modal.matcherType")}
          <select
            id={`${id}-matcher`}
            value={form.matcherType}
            onChange={(e) => updateForm("matcherType", e.target.value as TriggerRule["matcherType"])}
          >
            <option value="exact_length">{t("tenant.rules.matcher.exact_length")}</option>
            <option value="prefix_length">{t("tenant.rules.matcher.prefix_length")}</option>
            <option value="starts_with">{t("tenant.rules.matcher.starts_with")}</option>
            <option value="contains">{t("tenant.rules.matcher.contains")}</option>
            <option value="advanced">{t("tenant.rules.matcher.advanced")}</option>
          </select>
        </label>
        <label htmlFor={`${id}-team-policy`}>{t("tenant.rules.teamPolicy")}<select id={`${id}-team-policy`} value={form.teamSenderPolicy} onChange={(event)=>updateForm("teamSenderPolicy",event.target.value as "include"|"exclude")}><option value="include">{t("tenant.rules.teamPolicy.include")}</option><option value="exclude">{t("tenant.rules.teamPolicy.exclude")}</option></select><small>{t("tenant.rules.teamPolicy.help")}</small></label>
        {form.matcherType === "exact_length" || form.matcherType === "prefix_length" ? <div className="rule-modal-grid">{form.matcherType === "prefix_length" ? <label htmlFor={`${id}-prefix`}>{t("tenant.rules.modal.prefix")}<input id={`${id}-prefix`} required maxLength={64} value={form.prefix} onChange={(event) => updateForm("prefix", event.target.value)} placeholder={t("tenant.rules.modal.prefixPlaceholder")} /></label> : null}<label htmlFor={`${id}-digits`}>{t("tenant.rules.modal.digitLength")}<input id={`${id}-digits`} type="number" min={1} max={64} value={form.digitLength} onChange={(event) => updateForm("digitLength", Number(event.target.value))} /></label></div> : <label htmlFor={`${id}-pattern`}>{t(form.matcherType === "advanced" ? "tenant.rules.modal.safeExpression" : "tenant.rules.modal.literalPattern")}<input id={`${id}-pattern`} className="mono" required maxLength={240} value={form.pattern} onChange={(event) => updateForm("pattern", event.target.value)} placeholder={t(form.matcherType === "advanced" ? "tenant.rules.modal.advancedPlaceholder" : "tenant.rules.modal.literalPlaceholder")} /><small>{t(form.matcherType === "advanced" ? "tenant.rules.modal.advancedHelp" : "tenant.rules.modal.literalHelp")}</small></label>}
        <fieldset className="rule-command-config"><legend>{t("tenant.rules.command.title")}</legend><label className="check" htmlFor={`${id}-command`}><input id={`${id}-command`} type="checkbox" checked={form.groupCommand} onChange={event=>{const enabled=event.target.checked;setForm(current=>({...current,groupCommand:enabled,...(enabled?{matcherType:"starts_with",pattern:"/status"}:{}),actionId:current.actionId||commandActions[0]?.action_key||""}));if(enabled)setSample("/status ORD-42");setTestedSignature(null);setTestResult(null);setError(null)}}/><span><b>{t("tenant.rules.command.enable")}</b><small>{t("tenant.rules.command.enableBody")}</small></span></label>{form.groupCommand?<div className="rule-command-fields"><label htmlFor={`${id}-action`}>{t("tenant.rules.command.action")}<select id={`${id}-action`} required value={form.actionId} onChange={event=>updateForm("actionId",event.target.value)}><option value="">{t("tenant.rules.command.selectAction")}</option>{commandActions.map(action=><option key={action.action_key} value={action.action_key}>{action.name}</option>)}</select><small>{commandActions.length?t("tenant.rules.command.getOnly"):t("tenant.rules.command.noActions")}</small></label><div><b>{t("tenant.rules.command.input")}</b><small>{t("tenant.rules.command.inputBody")}</small>{commandInputs.map((row,index)=><div className="rule-command-input" key={index}><input aria-label={t("tenant.rules.command.inputKey")} placeholder={t("tenant.rules.command.inputKey")} value={row.key} maxLength={128} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,key:event.target.value}:item));setTestedSignature(null)}}/><input aria-label={t("tenant.rules.command.inputValue")} placeholder={t("tenant.rules.command.inputValueExample")} value={row.value} maxLength={500} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,value:event.target.value}:item));setTestedSignature(null)}}/><button type="button" className="button small secondary" disabled={commandInputs.length===1} onClick={()=>setCommandInputs(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>{t("tenant.rules.command.remove")}</button></div>)}<button type="button" className="text-button" onClick={()=>setCommandInputs(current=>[...current,{key:"",value:""}])}>{t("tenant.rules.command.addInput")}</button></div><label htmlFor={`${id}-success`}>{t("tenant.rules.command.successReply")}<textarea id={`${id}-success`} rows={2} required maxLength={1000} value={form.successReply} onChange={event=>updateForm("successReply",event.target.value)}/></label><label htmlFor={`${id}-failure`}>{t("tenant.rules.command.failureReply")}<textarea id={`${id}-failure`} rows={2} required maxLength={1000} value={form.failureReply} onChange={event=>updateForm("failureReply",event.target.value)}/></label><p className="form-note">{t("tenant.rules.command.variables")}</p></div>:null}</fieldset>
        <label htmlFor={`${id}-sample`}>{t("tenant.rules.modal.representativeMessage")}<textarea id={`${id}-sample`} rows={3} required value={sample} onChange={(event) => { setSample(event.target.value); setTestedSignature(null); setTestResult(null); setError(null); }} /></label>
        <div className="candidate-expression"><small>{t("tenant.rules.modal.generatedExpression")}</small><code><bdi>{candidatePattern || t("tenant.rules.modal.addPattern")}</bdi></code></div>
        {error ? <div className="settings-feedback error rule-modal-feedback" role="alert"><span>!</span><p>{error}</p></div> : null}
        {safeTestCurrent ? <div className="settings-feedback success rule-modal-feedback" role="status"><span>✓</span><p>{t("tenant.rules.modal.testPassed")} <bdi>{testResult?.matches?.map((match) => match.normalizedValue).join(", ")}</bdi>.</p></div> : <div className="rule-test-required" role="status"><span>◇</span><p><b>{t("tenant.rules.modal.testRequired")}</b><small>{t("tenant.rules.modal.testRequiredBody")}</small></p></div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t("tenant.rules.actions.cancel")}
          </button>
          <button type="button" className="button" disabled={testing || saving || !form.name.trim() || !sample.trim()} onClick={() => void testCandidate()}>{t(testing ? "tenant.rules.actions.testingSafely" : "tenant.rules.actions.runSafeTest")}</button>
          <button className="button primary" disabled={!form.name.trim() || !safeTestCurrent || saving}>{t(saving ? "tenant.rules.actions.saving" : "tenant.rules.actions.saveRule")}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function countForm(count: number) {
  if (count === 0) return "zero";
  if (count === 1) return "one";
  return "many";
}
