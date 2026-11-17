'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MetaTemplatePreparationAction, MetaTemplatePreparationPage, MetaTemplatePreparationView } from '../packages/core/src/meta-template-preparation-contract';
import { isTemplatePage, isTemplateView, parseTemplateIntent, templateActionResultMatches, templateCreateResultMatches, templateCancelSuperseded,
  templateIntentKey, templateIntentSettled, type TemplateIntent } from '../lib/meta-template-intent';
import { useI18n } from './I18nProvider';
import { useDeadlineCurrent } from './use-deadline-current';
import { InlineConfirmation } from './ModalDialog';
import { useVisibleRefresh } from './use-visible-refresh';
import { formatDateTime } from '../lib/i18n/format';

type Props = { connectionId: string; tenantId: string; actorId: string; canWrite: boolean; mutationHeaders: Record<string, string> };
const reasons = new Set(['CURRENT_PERMISSION_REQUIRED', 'BINDING_CHANGED', 'ACCOUNT_ACCESS_UNVERIFIED', 'SAME_BUSINESS_UNVERIFIED', 'INVENTORY_INCOMPLETE',
  'DEPENDENCIES_CHANGED', 'UNSUPPORTED_TEMPLATE', 'TARGET_CONTENT_CHANGED', 'TARGET_NOT_APPROVED', 'COPY_PARTIAL', 'COPY_OUTCOME_UNRESOLVED',
  'SIGNED_TEMPLATE_CHANGE', 'RUNTIME_UNQUALIFIED', 'PROVIDER_READ_UNAVAILABLE']);
class RequestFailure extends Error { constructor(readonly status: number) { super('META_TEMPLATE_REQUEST_FAILED'); } }

export function MetaTemplatePreparation(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const titleId = useId(), bodyId = useId();
  return <section className="connection-detail-section meta-template-preparation" aria-labelledby={titleId}>
    <div className="connection-detail-section-head"><div><h3 id={titleId}>{t('tenant.metaTemplates.title')}</h3><p>{t('tenant.metaTemplates.description')}</p></div>
      <button className="button small secondary" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>{t(open ? 'tenant.metaTemplates.hide' : 'tenant.metaTemplates.open')}</button></div>
    <div id={bodyId}>{open ? <TemplateSession key={JSON.stringify([props.connectionId, props.tenantId, props.actorId, props.mutationHeaders['x-wasalx-csrf'] ?? ''])} {...props} /> : null}</div>
  </section>;
}

function TemplateSession({ connectionId, tenantId, actorId, canWrite, mutationHeaders }: Props) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<MetaTemplatePreparationPage | null>(null);
  const [view, setView] = useState<MetaTemplatePreparationView | null>(null);
  const [intent, setIntent] = useState<TemplateIntent | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [loading, setLoading] = useState(true), [writing, setWriting] = useState(false);
  const [authorityLost, setAuthorityLost] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState(''), [selection, setSelection] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<TemplateIntent | null>(null);
  const alive = useRef(true), generation = useRef(0), busy = useRef(false), retained = useRef<TemplateIntent | null>(null);
  const allowed = useRef(canWrite), activeRead = useRef<AbortController | null>(null);
  useLayoutEffect(() => { allowed.current = canWrite; }, [canWrite]);
  const storageKey = templateIntentKey(tenantId, actorId, connectionId);
  const csrf = mutationHeaders['x-wasalx-csrf'] ?? '';
  const base = `/api/connections/${encodeURIComponent(connectionId)}/meta/template-preparations`;
  const targetId = useId(), confirmationId = useId();
  const name = (value: string | null) => value || t('tenant.metaTemplates.unnamed');

  const save = useCallback((next: TemplateIntent | null) => {
    try {
      if (next) { const text = JSON.stringify(next); sessionStorage.setItem(storageKey, text); if (sessionStorage.getItem(storageKey) !== text) throw new Error('STORAGE'); }
      else { sessionStorage.removeItem(storageKey); if (sessionStorage.getItem(storageKey) !== null) throw new Error('STORAGE'); }
      retained.current = next;
      if (alive.current) setIntent(next);
      return true;
    } catch { if (alive.current) { setStorageReady(false); setError('storage'); } return false; }
  }, [storageKey]);
  const request = useCallback(async (suffix: string, method: 'GET' | 'POST', original?: TemplateIntent, signal?: AbortSignal): Promise<unknown> => {
    const headers: Record<string, string> = { ...(csrf ? { 'x-wasalx-csrf': csrf } : {}), 'x-wasalx-template-actor': encodeURIComponent(actorId), 'x-wasalx-template-workspace': encodeURIComponent(tenantId) };
    if (original) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = original.key; }
    const response = await fetch(base + suffix, { method, headers, cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      ...(original ? { body: JSON.stringify(original.body) } : {}) });
    if (!response.ok) throw new RequestFailure(response.status);
    return response.json();
  }, [actorId, tenantId, base, csrf]);
  const fail = useCallback((failure: unknown) => {
    if (!alive.current) return;
    if (failure instanceof RequestFailure && [401, 403].includes(failure.status)) {
      setAuthorityLost(true); setPage(null); setView(null); setSelection([]); setConfirmation(null); setError('permission');
    } else setError(failure instanceof RequestFailure && failure.status === 501 ? 'unsupported' : 'load');
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (busy.current) return;
    const own = new AbortController(); activeRead.current?.abort(); activeRead.current = own;
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const next: unknown = await request('', 'GET', undefined, combined);
      if (!isTemplatePage(next, connectionId)) throw new Error('INVALID_VIEW');
      const original = retained.current;
      const exact: unknown = original?.planId && next.currentPlan?.id !== original.planId
        ? await request(`/${original.planId}`, 'GET', undefined, combined) : next.currentPlan;
      if (exact !== null && !isTemplateView(exact, connectionId, original?.planId ?? undefined)) throw new Error('INVALID_VIEW');
      if (!alive.current || combined.aborted || ticket !== generation.current) return;
      setPage(next); setView(exact); setAuthorityLost(false); setError(null);
      // A new observation invalidates selected inventory and an old confirmation.
      setSelection([]);
      if (original && templateIntentSettled(original, exact, connectionId) && save(null)) { setNotice('settled'); setView(next.currentPlan); }
      else if (original && templateCancelSuperseded(original, exact, connectionId) && save(null)) { setNotice('superseded'); setView(next.currentPlan); }
    } catch (failure) { if (alive.current && !combined.aborted && ticket === generation.current) fail(failure); }
    finally { if (alive.current && ticket === generation.current) setLoading(false); }
  }, [connectionId, fail, request, save]);

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = generation, currentRead = activeRead;
    alive.current = true;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      try { retained.current = parseTemplateIntent(sessionStorage.getItem(storageKey)); setIntent(retained.current); setStorageReady(true); }
      catch { setStorageReady(false); setError('storage'); }
      void refresh(controller.signal);
    });
    return () => { alive.current = false; controller.abort(); currentRead.current?.abort(); currentGeneration.current += 1; };
  }, [refresh, storageKey]);
  useVisibleRefresh(refresh, !writing && !confirmation && selection.length === 0 && !authorityLost);

  const run = async (original: TemplateIntent, resolve = false) => {
    if (busy.current || !allowed.current || authorityLost || !storageReady) return;
    if (resolve ? retained.current?.key !== original.key : retained.current !== null) return;
    if (resolve && original.action === 'CANCEL' && (!view || view.id !== original.planId || view.revision !== original.body.expectedRevision
      || !view.actions.cancel || view.originalCopy?.outcome === 'ATTEMPTED' || view.originalCopy?.outcome === 'UNKNOWN')) return;
    if (!resolve && original.action === 'COPY' && (!view?.expiresAt || Date.parse(view.expiresAt) <= Date.now())) { setError('expired'); return; }
    // Persist before dispatch. Failure to retain uncertainty is not permission to send.
    if (!resolve && !save(original)) return;
    busy.current = true; setWriting(true); setNotice(null); setError(null); setConfirmation(null);
    activeRead.current?.abort(); generation.current += 1; setLoading(false);
    const suffix = original.action === 'CREATE' ? resolve ? '/resolve' : ''
      : `/${original.planId}/${original.action.toLowerCase()}${resolve && original.action !== 'CANCEL' ? '/resolve' : ''}`;
    try {
      const result = await request(suffix, 'POST', original);
      // If unmounted, retain the pre-dispatch marker for deliberate readback on reopen.
      if (!alive.current) return;
      if (original.action === 'CREATE') {
        if (!templateCreateResultMatches(original, result)) throw new Error('INVALID_RESULT');
        if (result.state === 'NO_EFFECT') { if (save(null)) setNotice('noEffect'); }
        else save({ ...original, planId: result.id, operationId: result.operationId });
      } else if (original.action !== 'CANCEL') {
        if (!templateActionResultMatches(original, result)) throw new Error('INVALID_RESULT');
        const updated = { ...original, operationId: result.operationId };
        if (['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(result.pendingAction.state)) {
          if (save(null)) setNotice(result.pendingAction.state === 'CANCELLED' ? 'noEffect' : 'settled');
        } else save(updated);
      }
      // Cancel settles only from same-plan CANCELLED at the exact successor revision.
    } catch (failure) { fail(failure); }
    finally {
      busy.current = false;
      if (alive.current) { setWriting(false); void refresh(); }
    }
  };

  const blocked = loading || writing || !storageReady || authorityLost || error !== null || !canWrite || intent !== null;
  const fresh = useDeadlineCurrent(view?.expiresAt);
  const copyUnresolved = view?.originalCopy?.outcome === 'ATTEMPTED' || view?.originalCopy?.outcome === 'UNKNOWN';
  const canFinishCancel = intent?.action === 'CANCEL' && view?.id === intent.planId && view.revision === intent.body.expectedRevision && view.actions.cancel && !copyUnresolved;
  const canCopy = !blocked && view?.actions.copy === true && fresh && view.observationSha256 !== null && view.originalCopy === null;
  const create = () => {
    const prepare = page?.prepare;
    if (blocked || !prepare?.targets.some(item => item.id === target)) return;
    void run({ version: 1, key: crypto.randomUUID(), operationId: null, action: 'CREATE', planId: null,
      body: { targetConnectionId: target, expectedAccountRevision: prepare.accountRevision, expectedBindingRevision: prepare.bindingRevision } });
  };
  const action = (kind: MetaTemplatePreparationAction | 'CANCEL') => {
    if (blocked || !view || !view.actions[kind.toLowerCase() as keyof typeof view.actions]) return;
    if (kind === 'CANCEL') { if (copyUnresolved) return; void run({ version: 1, key: crypto.randomUUID(), operationId: null, action: kind, planId: view.id, body: { expectedRevision: view.revision } }); return; }
    const original: TemplateIntent = { version: 1, key: crypto.randomUUID(), operationId: null, action: kind, planId: view.id,
      body: { expectedRevision: view.revision, expectedObservationSha256: view.observationSha256,
        ...(kind === 'COPY' ? { choices: [...selection] } : {}) } };
    if (kind === 'COPY') {
      if (!canCopy || selection.length < 1 || selection.length > 500 || !selection.every(id => view.choices.some(choice => choice.id === id && choice.selectable))) return;
      setConfirmation(original);
    } else void run(original);
  };

  return <div className="meta-template-body" aria-busy={loading || writing || undefined}>
    <p className="connection-detail-note">{t('tenant.metaTemplates.boundary')}</p>
    {!canWrite ? <p>{t('tenant.metaTemplates.readOnly')}</p> : null}
    {!loading && !storageReady ? <p role="alert">{t('tenant.metaTemplates.error.storage')}</p> : null}
    {error && error !== 'storage' ? <p role="alert">{t(`tenant.metaTemplates.error.${error}`)}</p> : null}
    {notice ? <p role="status">{t(`tenant.metaTemplates.notice.${notice}`)}</p> : null}
    {intent ? <div className="meta-template-pending" role="status"><p>{t('tenant.metaTemplates.pending')}</p>
      <button className="button secondary" disabled={writing || loading || !canWrite || authorityLost || !storageReady || (intent.action === 'CANCEL' && (!canFinishCancel || error !== null))} onClick={() => void run(intent, true)}>{t(intent.action === 'CANCEL' ? 'tenant.metaTemplates.finishCancel' : 'tenant.metaTemplates.resolve')}</button></div> : null}
    <div className="connection-detail-authorization-actions"><button className="button small secondary" disabled={loading || writing || Boolean(confirmation)} onClick={() => void refresh()}>{t(loading ? 'tenant.metaTemplates.loading' : 'tenant.metaTemplates.refresh')}</button></div>
    {page && (!view || view.state === 'CANCELLED') ? <div className="meta-template-create">
      {canWrite && page.prepare ? <><label htmlFor={targetId}>{t('tenant.metaTemplates.target')}</label>
        <select id={targetId} value={target} disabled={blocked} onChange={event => setTarget(event.target.value)}>
          <option value="">{t('tenant.metaTemplates.chooseTarget')}</option>
          {page.prepare.targets.map(item => <option key={item.id} value={item.id}>{name(item.name)}</option>)}
        </select><button className="button primary" disabled={blocked || !target || !page.prepare.targets.some(item => item.id === target)} onClick={create}>{t('tenant.metaTemplates.prepare')}</button>
        {!page.prepare.targets.length ? <p>{t('tenant.metaTemplates.noTargets')}</p> : null}</> : canWrite ? <p>{t('tenant.metaTemplates.unavailable')}</p> : null}
    </div> : null}
    {view ? <div className="meta-template-review">
      <dl className="meta-template-context"><div><dt>{t('tenant.metaTemplates.source')}</dt><dd><bdi>{name(view.sourceConnection.name)}</bdi></dd></div>
        <div><dt>{t('tenant.metaTemplates.target')}</dt><dd><bdi>{name(view.targetConnection.name)}</bdi></dd></div></dl>
      <p role="status">{t(`tenant.metaTemplates.state.${view.state}`)}</p>
      {view.observedAt ? <p>{t('tenant.metaTemplates.observed')} <time dateTime={view.observedAt}>{formatDateTime(view.observedAt, locale)}</time></p> : null}
      {view.reasons.length ? <ul>{view.reasons.map(reason => <li key={reason}>{t(`tenant.metaTemplates.reason.${reasons.has(reason) ? reason : 'PROVIDER_READ_UNAVAILABLE'}`)}</li>)}</ul> : null}
      {view.originalCopy ? <p>{t(`tenant.metaTemplates.copyOutcome.${view.originalCopy.outcome}`)}</p> : null}
      <fieldset disabled={!canCopy || Boolean(confirmation)}><legend>{t('tenant.metaTemplates.templates')}</legend>
        <p>{t('tenant.metaTemplates.selectionHelp')}</p>
        {view.choices.length ? <ul className="meta-template-choices">{view.choices.map(choice => <li key={choice.id}>
          <label><input type="checkbox" aria-labelledby={`${targetId}-${choice.id}`} checked={selection.includes(choice.id)} disabled={!choice.selectable || !canCopy || !selection.includes(choice.id) && selection.length >= 500}
            onChange={event => setSelection(current => event.target.checked ? [...current, choice.id] : current.filter(id => id !== choice.id))} />
            <span id={`${targetId}-${choice.id}`}><bdi>{choice.name}</bdi> <bdi>({choice.language})</bdi><small>{t(`tenant.metaTemplates.compatibility.${choice.compatibility}`)}</small></span></label>
        </li>)}</ul> : <p>{t('tenant.metaTemplates.noTemplates')}</p>}
      </fieldset>
      <div className="connection-detail-authorization-actions">
        <button className="button secondary" disabled={blocked || !view.actions.observe} onClick={() => action('OBSERVE')}>{t('tenant.metaTemplates.observe')}</button>
        <button className="button secondary" disabled={blocked || !view.actions.reconcile} onClick={() => action('RECONCILE')}>{t('tenant.metaTemplates.reconcile')}</button>
        <button className="button primary" disabled={!canCopy || selection.length === 0} onClick={() => action('COPY')}>{t('tenant.metaTemplates.reviewCopy')}</button>
        <button className="button secondary" disabled={blocked || copyUnresolved || !view.actions.cancel} onClick={() => action('CANCEL')}>{t('tenant.metaTemplates.cancelPlan')}</button>
      </div>
      <p>{t('tenant.metaTemplates.closeHelp')}</p>
      {confirmation ? <InlineConfirmation aria-labelledby={confirmationId} cancel={() => setConfirmation(null)} busy={writing}>
        <h4 id={confirmationId}>{t('tenant.metaTemplates.confirmTitle')}</h4><p>{t('tenant.metaTemplates.confirmBody')}</p>
        <p>{t('tenant.metaTemplates.source')}: <bdi>{name(view.sourceConnection.name)}</bdi></p><p>{t('tenant.metaTemplates.target')}: <bdi>{name(view.targetConnection.name)}</bdi></p>
        <ul>{view.choices.filter(choice => selection.includes(choice.id)).map(choice => <li key={choice.id}><bdi>{choice.name}</bdi> <bdi>({choice.language})</bdi></li>)}</ul>
        <div className="connection-detail-authorization-actions"><button className="button secondary" data-inline-confirm-initial-focus disabled={writing} onClick={() => setConfirmation(null)}>{t('tenant.metaTemplates.back')}</button>
          <button className="button primary" disabled={!canCopy || writing} onClick={() => void run(confirmation)}>{t('tenant.metaTemplates.confirmCopy')}</button></div>
      </InlineConfirmation> : null}
    </div> : null}
  </div>;
}
