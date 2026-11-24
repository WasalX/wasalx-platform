"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { parseMetaTransitionOperatorRequest, type MetaTransitionOperatorAction, type MetaTransitionOperatorRequest, type MetaTransitionOperatorReview, type MetaTransitionOperatorSummary } from "../../packages/core/src/meta-transition-operator-contract.ts";
import { isOperatorReview, isOperatorReviewSummary, operatorReviewActions, operatorReviewSettled, operatorReviewStorageKey, parseOperatorReviewIntent, type OperatorReviewIntent } from "../../lib/meta-transition-operator-intent.ts";
import { formatDateTime, formatNumber } from "../../lib/i18n/format.ts";
import { useI18n } from "../I18nProvider";
import { InlineConfirmation, ModalDialog } from "../ModalDialog";
import { useVisibleRefresh } from "../use-visible-refresh";
import styles from "./PlatformConsole.module.css";

type Request = <T>(path: string, options?: { method?: string; body?: Record<string, unknown>; idempotencyKey?: string; signal?: AbortSignal }) => Promise<T>;
type Props = { tenantId: string; tenantName: string; recoveryScope: string; request: Request; close: () => void };
const prefix = "platform.metaTransition.";
const status = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
const deadline = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);

export function MetaTransitionOperator(props: Props) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<MetaTransitionOperatorSummary[]>([]), [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0), alive = useRef(false);
  const pending = useRef<"list" | "write" | null>(null);
  // A completed list is admissible only after its selected-plan render commits.
  useLayoutEffect(() => { if (!loading && pending.current === "list") pending.current = null; }, [loading]);
  function beginWrite() {
    if (!alive.current || pending.current !== null) return false;
    pending.current = "write"; setBusy(true); return true;
  }
  function endWrite() {
    if (pending.current !== "write") return;
    pending.current = null;
    if (alive.current) setBusy(false);
  }
  function loseAuthority() {
    generation.current++;
    if (pending.current === "list") { pending.current = null; setLoading(false); }
    setPlans([]); setSelected(""); setFailed(true);
  }
  const base = `operations/tenants/${props.tenantId}/meta/account-transitions`;
  async function read(signal?: AbortSignal) {
    if (!alive.current || signal?.aborted || pending.current !== null) return;
    pending.current = "list"; setLoading(true);
    const version = ++generation.current;
    try {
      const value = await props.request<{ tenantId: string; plans: unknown[] }>(base, { signal: deadline(signal) });
      if (value.tenantId !== props.tenantId || !Array.isArray(value.plans) || value.plans.length > 50 || !value.plans.every(isOperatorReviewSummary) || new Set(value.plans.map(x => x.id)).size !== value.plans.length) throw Error("Invalid plan list");
      if (alive.current && version === generation.current && !signal?.aborted) { setPlans(value.plans); setFailed(false); }
    } catch { if (alive.current && version === generation.current && !signal?.aborted) { setPlans([]); setSelected(""); setFailed(true); } }
    finally { if (alive.current && version === generation.current && !signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; const controller = new AbortController(), counter = generation;
    Promise.resolve().then(() => { if (!controller.signal.aborted) void read(controller.signal); });
    return () => { alive.current = false; counter.current++; controller.abort(); };
    // Parent keys this dialog to tenant and authenticated operator context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => { if (pending.current !== "write") props.close(); };
  return <ModalDialog close={close} className={styles.backdrop} aria-labelledby="transition-operator-title"><section className={styles.dialog}>
    <header><div><p className={styles.eyebrow}><bdi>{props.tenantName}</bdi></p><h2 id="transition-operator-title">{t(`${prefix}title`)}</h2></div><button type="button" disabled={busy} aria-label={t("platform.actions.closeDialog")} onClick={close}>×</button></header>
    <section className={styles.detailSection}><p>{t(`${prefix}purpose`)}</p><p>{t(`${prefix}simulated`)}</p>
      {loading ? <p role="status">{t(`${prefix}loading`)}</p> : null}{failed ? <p role="alert">{t(`${prefix}unavailable`)}</p> : null}
      <label className={styles.transitionSelect}>{t(`${prefix}plan`)}<select value={selected} disabled={busy || loading} onChange={e => setSelected(e.target.value)}><option value="">{t(`${prefix}choose`)}</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
      {!loading && !failed && !plans.length ? <p>{t(`${prefix}empty`)}</p> : null}
      <button className={styles.secondaryButton} type="button" disabled={busy || loading} onClick={() => void read()}>{t(`${prefix}refreshList`)}</button>
    </section>
    {selected && plans.some(plan => plan.id === selected) ? <ReviewSession key={`${props.recoveryScope}:${props.tenantId}:${selected}`} {...props} planId={selected} base={`${base}/${selected}/review`} parentLoading={loading} beginWrite={beginWrite} endWrite={endWrite} authorityLost={loseAuthority} /> : null}
  </section></ModalDialog>;
}
function ReviewSession({ planId, base, parentLoading, beginWrite, endWrite, authorityLost, ...props }: Props & { planId: string; base: string; parentLoading: boolean; beginWrite: () => boolean; endWrite: () => void; authorityLost: () => void }) {
  const { t, locale } = useI18n();
  const storageKey = operatorReviewStorageKey(props.recoveryScope, props.tenantId, planId);
  const [view, setView] = useState<MetaTransitionOperatorReview | null>(null), [loading, setLoading] = useState(true);
  const [recoverable, setRecoverable] = useState(false);
  const [saving, setSaving] = useState(false), [held, setHeld] = useState(false), [storageFailed, setStorageFailed] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const intent = useRef<OperatorReviewIntent | null>(null), alive = useRef(false), writing = useRef(false), generation = useRef(0);
  function settle(value: unknown) {
    if (!intent.current || !operatorReviewSettled(intent.current, value)) return false;
    try { window.sessionStorage.removeItem(storageKey); intent.current = null; setRecoverable(false); setHeld(false); setNotice(value.state); return true; }
    catch { setStorageFailed(true); return false; }
  }
  async function read(signal?: AbortSignal) {
    if (writing.current) return;
    const version = ++generation.current;
    try {
      const query = intent.current ? `?requestKey=${encodeURIComponent(intent.current.key)}` : "";
      const value = await props.request<unknown>(base + query, { signal: deadline(signal) });
      if (!isOperatorReview(value, props.tenantId, planId)) throw Error("Invalid current review");
      if (alive.current && version === generation.current && !signal?.aborted) { setView(value); setError(null); settle(value.pendingCommand); }
    } catch (failure) { if (alive.current && version === generation.current && !signal?.aborted) {
      setView(null); setError(status(failure) === 401 || status(failure) === 403 ? "authority" : "unavailable");
      if (status(failure) === 401 || status(failure) === 403) authorityLost();
    } }
    finally { if (alive.current && version === generation.current && !signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; const controller = new AbortController(), counter = generation;
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      try { const saved = window.sessionStorage.getItem(storageKey); intent.current = saved === null ? null : parseOperatorReviewIntent(saved, props.recoveryScope, props.tenantId, planId); setHeld(saved !== null); setRecoverable(intent.current !== null); if (saved !== null && !intent.current) setStorageFailed(true); }
      catch { setStorageFailed(true); }
      void read(controller.signal);
    });
    return () => { alive.current = false; counter.current++; controller.abort(); };
    // Parent unmounts on tenant, plan or authenticated operator context change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useVisibleRefresh(read, !saving);
  async function submit(action: MetaTransitionOperatorAction, body: MetaTransitionOperatorRequest, resolve = false) {
    if (!view || loading || parentLoading || writing.current || storageFailed || !alive.current) return;
    if (!resolve && (held || intent.current || !view.actions[action] || body.expectedRevision !== view.revision || body.expectedReviewSha256 !== view.reviewSha256)) return;
    let saved = intent.current;
    if (resolve && (!saved || saved.scope !== props.recoveryScope || saved.tenantId !== props.tenantId || saved.planId !== planId)) return;
    // The synchronous parent admission also covers a list request whose loading
    // render has not committed yet. The parent owns release after child removal.
    if (!beginWrite()) return;
    writing.current = true; generation.current++; setSaving(true); setError(null); setNotice(null);
    try {
      if (!resolve) {
        saved = { scope: props.recoveryScope, tenantId: props.tenantId, planId, key: crypto.randomUUID(), action, request: body };
        try { window.sessionStorage.setItem(storageKey, JSON.stringify(saved)); }
        catch { setStorageFailed(true); return; }
        intent.current = saved; setRecoverable(true); setHeld(true);
      }
      if (!saved) return;
      const result = await props.request<unknown>(`${base}/${saved.action.toLowerCase()}${resolve ? "/resolve" : ""}`, { method: "POST", body: { ...saved.request }, idempotencyKey: saved.key, signal: deadline() });
      if (alive.current && !settle(result)) setError("uncertain");
    } catch (failure) { if (alive.current) { setError(status(failure) === 401 || status(failure) === 403 ? "authority" : "uncertain"); if (status(failure) === 401 || status(failure) === 403) { setView(null); authorityLost(); } } }
    finally { writing.current = false; endWrite(); if (alive.current) setSaving(false); }
    // Authenticated read only; a POST is never automatically repeated or resolved.
    if (alive.current) await read();
  }
  return <section className={styles.detailSection} aria-busy={loading || saving || parentLoading}>
    {loading ? <p role="status">{t(`${prefix}loading`)}</p> : null}{error ? <p role="alert">{t(`${prefix}${error}`)}</p> : null}
    {notice ? <p role="status">{t(`${prefix}result.${notice}`)}</p> : null}
    {held ? <p role="status">{t(`${prefix}held`)}</p> : null}{storageFailed ? <p role="alert">{t(`${prefix}storage`)}</p> : null}
    {view ? <>
      <h3><bdi>{view.name}</bdi></h3><p>{t(`${prefix}phase.${view.phase}`)}</p>
      <dl className={styles.detailGrid}><div><dt>{t(`${prefix}mode`)}</dt><dd>{t(`${prefix}mode.${view.requestedMode}`)}</dd></div><div><dt>{t(`${prefix}currencies`)}</dt><dd><bdi>{view.sourceCurrency ?? t(`${prefix}unknown`)}</bdi> <span className="reading-arrow" aria-hidden="true">→</span> <bdi>{view.targetCurrency}</bdi></dd></div><div><dt>{t(`${prefix}connections`)}</dt><dd>{formatNumber(view.connectionCount, locale)}</dd></div></dl>
      <ul>{view.connectionNames.map((name, i) => <li key={i}><bdi>{name}</bdi></li>)}</ul>
      <dl className={styles.detailGrid}>{Object.entries(view.proof).map(([name, value]) => <div key={name}><dt>{t(`${prefix}proof.${name}`)}</dt><dd>{t(`${prefix}proofState.${value}`)}</dd></div>)}</dl>
      {view.checkpoints.length ? <ul>{view.checkpoints.map(item => <li key={item.stage}>{t(`${prefix}stage.${item.stage}`)}: {t(`${prefix}outcome.${item.outcome}`)}</li>)}</ul> : null}
      {view.reasons.length ? <ul>{view.reasons.map(reason => <li key={reason}>{t(`${prefix}reason.${reason}`)}</li>)}</ul> : null}
      {!held && !storageFailed ? <ReviewForm key={`${view.revision}:${view.reviewSha256}`} view={view} busy={saving || loading || parentLoading} submit={submit} /> : null}
    </> : null}
    <div className={styles.transitionActions}><button type="button" className={styles.secondaryButton} disabled={saving || loading || parentLoading} onClick={() => { setLoading(true); void read(); }}>{t(`${prefix}refresh`)}</button>
      {held && recoverable && view && !storageFailed ? <button type="button" className={styles.secondaryButton} disabled={saving || loading || parentLoading} onClick={() => { const saved = intent.current; if (saved) void submit(saved.action, saved.request, true); }}>{t(`${prefix}resolve`)}</button> : null}
    </div>
  </section>;
}
function ReviewForm({ view, busy, submit }: { view: MetaTransitionOperatorReview; busy: boolean; submit: (action: MetaTransitionOperatorAction, body: MetaTransitionOperatorRequest) => Promise<void> }) {
  const { t, locale } = useI18n();
  const [action, setAction] = useState<MetaTransitionOperatorAction | "">(""), [confirmation, setConfirmation] = useState<MetaTransitionOperatorRequest | null>(null);
  const [payment, setPayment] = useState(view.originalGrant?.sourcePayment ?? ""), [arrangement, setArrangement] = useState(view.originalGrant?.managed?.arrangementVersionId ?? "");
  const [receiver, setReceiver] = useState(view.originalGrant?.managed?.targetReceivingBusinessId ?? ""), [terms, setTerms] = useState(view.originalGrant?.managed?.targetTermsDocumentText ?? ""), [version, setVersion] = useState(view.originalGrant?.managed?.targetTermsVersion ?? "");
  const [accepted, setAccepted] = useState(false), [reviewed, setReviewed] = useState(false), [invalid, setInvalid] = useState(false);
  const managed = view.requestedMode === "WASALX_MANAGED", fixed = view.originalGrant !== null;
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!action || busy || !reviewed || !view.actions[action]) return;
    const data = new FormData(event.currentTarget), parsed = parseMetaTransitionOperatorRequest(action, { expectedRevision: view.revision, expectedReviewSha256: view.reviewSha256, evidenceSha256: data.get("evidence"), confirmed: true,
      ...(action === "PREREQUISITES" ? { sourcePayment: payment, ...(managed ? { managed: { arrangementVersionId: arrangement, targetReceivingBusinessId: receiver, targetTermsDocumentText: terms, targetTermsVersion: version } } : {}) } : {}),
      ...(action === "TARGET" ? { templateEvidenceSha256: data.get("templates"), flowEvidenceSha256: data.get("flows") } : {}) });
    if (!parsed || new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 65536 || action === "PREREQUISITES" && (view.requestedMode === "CUSTOMER" ? parsed.sourcePayment !== "CARD" : !accepted || !fixed && !view.arrangements.some(x => x.id === arrangement))) { setInvalid(true); return; }
    setInvalid(false); setConfirmation(parsed);
  }
  const changeCommercial = (change: () => void) => { change(); setAccepted(false); setConfirmation(null); };
  return <form onSubmit={prepare} onChangeCapture={() => setConfirmation(null)}>
    <div className={styles.transitionFields}><label>{t(`${prefix}reviewKind`)}<select required value={action} disabled={busy} onChange={e => { setAction(e.target.value as typeof action); setAccepted(false); setReviewed(false); setInvalid(false); }}><option value="">{t(`${prefix}choose`)}</option>{operatorReviewActions.filter(a => view.actions[a]).map(a => <option key={a} value={a}>{t(`${prefix}action.${a}`)}</option>)}</select></label>
      {action ? <>
        <p>{t(`${prefix}help.${action}`)}</p>
        <label>{t(`${prefix}evidence`)}<input name="evidence" required pattern="[a-f0-9]{64}" minLength={64} maxLength={64} dir="ltr" autoComplete="off" disabled={busy} /></label>
        {action === "PREREQUISITES" ? <>
          {fixed ? <p>{t(`${prefix}originalGrant`)}</p> : null}
          <label>{t(`${prefix}sourcePayment`)}<select required value={payment} disabled={busy || fixed} onChange={e => changeCommercial(() => setPayment(e.target.value as typeof payment))}><option value="">{t(`${prefix}choose`)}</option><option value="CARD">{t(`${prefix}payment.CARD`)}</option>{managed ? <option value="LINE">{t(`${prefix}payment.LINE`)}</option> : null}</select></label>
          {managed ? <>
            <label>{t(`${prefix}arrangement`)}<select value={arrangement} required disabled={busy || fixed} onChange={e => changeCommercial(() => setArrangement(e.target.value))}><option value="">{t(`${prefix}choose`)}</option>{fixed ? <option value={arrangement}>{t(`${prefix}originalArrangement`)}</option> : view.arrangements.map(item => <option key={item.id} value={item.id}>{item.label} · {formatDateTime(item.expiresAt, locale)}</option>)}</select></label>
            <label>{t(`${prefix}receiver`)}<input required value={receiver} onChange={e => changeCommercial(() => setReceiver(e.target.value))} pattern="[0-9]{1,32}" maxLength={32} dir="ltr" inputMode="numeric" readOnly={fixed} disabled={busy} /></label>
            <label>{t(`${prefix}termsVersion`)}<input required value={version} onChange={e => changeCommercial(() => setVersion(e.target.value))} pattern="[A-Za-z0-9._\-]{1,128}" maxLength={128} dir="ltr" readOnly={fixed} disabled={busy} /></label>
            <label>{t(`${prefix}terms`)}<textarea required value={terms} onChange={e => changeCommercial(() => setTerms(e.target.value))} maxLength={32768} dir="auto" readOnly={fixed} disabled={busy} /></label>
            <label className={styles.transitionCheck}><input type="checkbox" required checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} /><span>{t(`${prefix}acceptTerms`)}</span></label>
          </> : null}
        </> : null}
        {action === "TARGET" ? <><label>{t(`${prefix}templates`)}<input name="templates" required pattern="[a-f0-9]{64}" minLength={64} maxLength={64} dir="ltr" disabled={busy} /></label><label>{t(`${prefix}flows`)}<input name="flows" required pattern="[a-f0-9]{64}" minLength={64} maxLength={64} dir="ltr" disabled={busy} /></label></> : null}
        <label className={styles.transitionCheck}><input type="checkbox" name="reviewed" required checked={reviewed} onChange={e => setReviewed(e.target.checked)} disabled={busy} /><span>{t(`${prefix}confirmEvidence`)}</span></label>
      </> : null}
    </div>
    {invalid ? <p role="alert">{t(`${prefix}invalid`)}</p> : null}
    {confirmation && action ? <InlineConfirmation className={styles.supportConfirmation} busy={busy} aria-labelledby="transition-review-confirm" cancel={() => setConfirmation(null)}><div><b id="transition-review-confirm">{t(`${prefix}confirmTitle`)}</b><p>{t(`${prefix}confirmBody`)}</p></div><div><button type="button" data-inline-confirm-initial-focus className={styles.secondaryButton} disabled={busy} onClick={() => setConfirmation(null)}>{t("platform.actions.cancel")}</button><button type="button" className={styles.primaryButton} disabled={busy || !view.actions[action]} onClick={() => void submit(action, confirmation)}>{t(`${prefix}record`)}</button></div></InlineConfirmation> : <div className={styles.transitionActions}><button type="submit" className={styles.primaryButton} disabled={busy || !action || !view.actions[action]}>{t(`${prefix}review`)}</button></div>}
  </form>;
}
