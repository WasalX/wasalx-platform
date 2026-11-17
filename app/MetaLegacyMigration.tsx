'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MetaLegacyMigrationAction, MetaLegacyMigrationPage, MetaLegacyMigrationView } from '../packages/core/src/meta-legacy-migration-contract';
import { isLegacyPage, isLegacyView, parseLegacyIntent, legacyActionResultMatches, legacyCreateResultMatches, legacyCancelSuperseded,
  legacyIntentKey, legacyIntentSettled, type LegacyIntent } from '../lib/meta-legacy-intent';
import { useI18n } from './I18nProvider';
import { useDeadlineCurrent } from './use-deadline-current';
import { InlineConfirmation } from './ModalDialog';
import { useVisibleRefresh } from './use-visible-refresh';
import { MetaSignup } from './MetaSignup';
import { formatDateTime } from '../lib/i18n/format';

type Props = { connectionId: string; tenantId: string; actorId: string; canWrite: boolean; mutationHeaders: Record<string, string> };
class RequestFailure extends Error { constructor(readonly status: number) { super('META_MIGRATION_REQUEST_FAILED'); } }

export function MetaLegacyMigration(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const titleId = useId(), bodyId = useId();
  return <section className="connection-detail-section meta-legacy-migration" aria-labelledby={titleId}>
    <div className="connection-detail-section-head"><div><h3 id={titleId}>{t('tenant.metaLegacy.title')}</h3><p>{t('tenant.metaLegacy.description')}</p></div>
      <button className="button small secondary" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>{t(open ? 'tenant.metaLegacy.hide' : 'tenant.metaLegacy.open')}</button></div>
    <div id={bodyId}>{open ? <LegacySession key={JSON.stringify([props.connectionId, props.tenantId, props.actorId, props.mutationHeaders['x-wasalx-csrf'] ?? ''])} {...props} /> : null}</div>
  </section>;
}

function LegacySession({ connectionId, tenantId, actorId, canWrite, mutationHeaders }: Props) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<MetaLegacyMigrationPage | null>(null);
  const [view, setView] = useState<MetaLegacyMigrationView | null>(null);
  const [intent, setIntent] = useState<LegacyIntent | null>(null);
  const [storageReady, setStorageReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true), [writing, setWriting] = useState(false);
  const [authorityLost, setAuthorityLost] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [authorizationOpen, setAuthorizationOpen] = useState(false), [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<LegacyIntent | null>(null);
  const alive = useRef(true), generation = useRef(0), busy = useRef(false), retained = useRef<LegacyIntent | null>(null);
  const allowed = useRef(canWrite), activeRead = useRef<AbortController | null>(null);
  useLayoutEffect(() => { allowed.current = canWrite; }, [canWrite]);
  const storageKey = legacyIntentKey(tenantId, actorId, connectionId);
  const csrf = mutationHeaders['x-wasalx-csrf'] ?? '';
  const base = `/api/connections/${encodeURIComponent(connectionId)}/meta/legacy-migrations`;
  const confirmationId = useId();
  const name = (value: string | null) => value || t('tenant.metaLegacy.unnamed');

  const save = useCallback((next: LegacyIntent | null) => {
    try {
      if (next) { const text = JSON.stringify(next); sessionStorage.setItem(storageKey, text); if (sessionStorage.getItem(storageKey) !== text) throw new Error('STORAGE'); }
      else { sessionStorage.removeItem(storageKey); if (sessionStorage.getItem(storageKey) !== null) throw new Error('STORAGE'); }
      retained.current = next;
      if (alive.current) setIntent(next);
      return true;
    } catch { if (alive.current) { setStorageReady(false); } return false; }
  }, [storageKey]);
  const request = useCallback(async (suffix: string, method: 'GET' | 'POST', original?: LegacyIntent, signal?: AbortSignal): Promise<unknown> => {
    const headers: Record<string, string> = { ...(csrf ? { 'x-wasalx-csrf': csrf } : {}), 'x-wasalx-legacy-actor': encodeURIComponent(actorId), 'x-wasalx-legacy-workspace': encodeURIComponent(tenantId) };
    if (original) { headers['content-type'] = 'application/json'; if (original.action !== 'CANCEL') headers['idempotency-key'] = original.key; }
    const response = await fetch(base + suffix, { method, headers, cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      ...(original ? { body: JSON.stringify(original.body) } : {}) });
    if (!response.ok) throw new RequestFailure(response.status);
    return response.json();
  }, [actorId, tenantId, base, csrf]);
  const fail = useCallback((failure: unknown) => {
    if (!alive.current) return;
    if (failure instanceof RequestFailure && [401, 403].includes(failure.status)) {
      setAuthorityLost(true); setPage(null); setView(null); setAuthorizationOpen(false); setConfirmation(null); setError('permission');
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
      if (!isLegacyPage(next, connectionId)) throw new Error('INVALID_VIEW');
      const original = retained.current;
      const exact: unknown = original?.planId && next.currentPlan?.id !== original.planId
        ? await request(`/${original.planId}`, 'GET', undefined, combined) : next.currentPlan;
      if (exact !== null && !isLegacyView(exact, connectionId, original?.planId ?? undefined)) throw new Error('INVALID_VIEW');
      if (!alive.current || combined.aborted || ticket !== generation.current) return;
      setPage(next); setView(exact); setAuthorityLost(false); setError(null);
      setConfirmation(null);
      if (original && legacyIntentSettled(original, exact, connectionId) && save(null)) { setNotice('settled'); setView(next.currentPlan); }
      else if (original && legacyCancelSuperseded(original, exact, connectionId) && save(null)) { setNotice('superseded'); setView(next.currentPlan); }
    } catch (failure) { if (alive.current && !combined.aborted && ticket === generation.current) fail(failure); }
    finally { if (alive.current && ticket === generation.current) setLoading(false); }
  }, [connectionId, fail, request, save]);

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = generation, currentRead = activeRead;
    alive.current = true;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      try { retained.current = parseLegacyIntent(sessionStorage.getItem(storageKey)); setIntent(retained.current); setStorageReady(true); }
      catch { setStorageReady(false); }
      void refresh(controller.signal);
    });
    return () => { alive.current = false; controller.abort(); currentRead.current?.abort(); currentGeneration.current += 1; };
  }, [refresh, storageKey]);
  useVisibleRefresh(refresh, !writing && !confirmation && !authorizationOpen && !authorityLost);

  const run = async (original: LegacyIntent, resolve = false) => {
    if (busy.current || !allowed.current || authorityLost || !storageReady) return;
    if (resolve ? retained.current?.key !== original.key : retained.current !== null) return;
    if (resolve && original.action === 'CANCEL' && (!view || view.id !== original.planId || view.revision !== original.body.expectedRevision
      || !view.actions.cancel || view.originalRegistration !== null)) return;
    if (!resolve && original.action === 'REGISTER' && (!view || !view.actions.register || !view.capability.qualificationOnly || view.originalRegistration !== null || !view.expiresAt || Date.parse(view.expiresAt) <= Date.now() || original.body.expectedRevision !== view.revision || original.body.expectedReviewSha256 !== view.reviewSha256)) { setError('expired'); return; }
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
        if (!legacyCreateResultMatches(original, result)) throw new Error('INVALID_RESULT');
        if (result.state === 'NO_EFFECT') { if (save(null)) setNotice('noEffect'); }
        else {
          const acknowledged = { ...original, planId: result.id, operationId: result.operationId };
          if (!save(acknowledged)) return;
          const exact: unknown = await request(`/${result.id}`, 'GET');
          if (!isLegacyView(exact, connectionId, result.id ?? undefined)) throw new Error('INVALID_RESULT');
          if (!alive.current) return;
          if (save(null)) { setView(exact); setNotice('settled'); }
        }
      } else if (original.action !== 'CANCEL') {
        if (!legacyActionResultMatches(original, result)) throw new Error('INVALID_RESULT');
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

  const blocked = loading || writing || authorizationBusy || !storageReady || authorityLost || error !== null || !canWrite || intent !== null;
  const fresh = useDeadlineCurrent(view?.expiresAt);
  const canFinishCancel = intent?.action === 'CANCEL' && view?.id === intent.planId && view.revision === intent.body.expectedRevision && view.actions.cancel && view.originalRegistration === null;
  const canRegister = !blocked && view?.actions.register === true && view.capability.qualificationOnly && fresh && view.originalRegistration === null;
  const canPrepare = page?.prepare && (!view || ['CANCELLED', 'RECONCILED_PAUSED'].includes(view.state));
  const create = () => {
    const prepare = page?.prepare;
    if (blocked || !canPrepare || !prepare) return;
    void run({ version: 1, key: crypto.randomUUID(), operationId: null, action: 'CREATE', planId: null,
      body: { templateObservationOperationId: prepare.templateObservationOperationId, expectedSourceBindingRevision: prepare.sourceBindingRevision, expectedTargetBindingRevision: prepare.targetBindingRevision } });
  };
  const action = (kind: MetaLegacyMigrationAction | 'CANCEL') => {
    if (blocked || !view || !view.actions[kind.toLowerCase() as keyof typeof view.actions]) return;
    if (kind === 'CANCEL') { if (view.originalRegistration !== null) return; void run({ version: 1, key: crypto.randomUUID(), operationId: null, action: kind, planId: view.id, body: { expectedRevision: view.revision } }); return; }
    const original: LegacyIntent = { version: 1, key: crypto.randomUUID(), operationId: null, action: kind, planId: view.id,
      body: { expectedRevision: view.revision, expectedReviewSha256: view.reviewSha256, ...(kind === 'REGISTER' ? { confirmCutover: true as const } : {}) } };
    if (kind === 'REGISTER') { if (canRegister) setConfirmation(original); } else void run(original);
  };
  const impact = view ? <><p>{t('tenant.metaLegacy.impact.pause', { count: view.impact.sourceConnections })}</p>
    <p>{t('tenant.metaLegacy.impact.history', { flows: view.impact.inheritedFlowVersions, templates: view.impact.templates })}</p>
    <p>{t('tenant.metaLegacy.impact.paused')}</p></> : null;
  return <div className="meta-legacy-body" aria-busy={loading || writing || undefined}>
    <p className="connection-detail-note">{t('tenant.metaLegacy.boundary')}</p>
    {!canWrite ? <p>{t('tenant.metaLegacy.readOnly')}</p> : null}
    {storageReady === false ? <p role="alert">{t('tenant.metaLegacy.error.storage')}</p> : null}
    {error ? <p role="alert">{t(`tenant.metaLegacy.error.${error}`)}</p> : null}
    {notice ? <p role="status">{t(`tenant.metaLegacy.notice.${notice}`)}</p> : null}
    {intent ? <div role="status"><p>{t('tenant.metaLegacy.pending')}</p>
      <button className="button secondary" disabled={writing || loading || authorizationBusy || !canWrite || authorityLost || !storageReady || (intent.action === 'CANCEL' && (!canFinishCancel || error !== null))} onClick={() => void run(intent, true)}>{t(intent.action === 'CANCEL' ? 'tenant.metaLegacy.finishCancel' : 'tenant.metaLegacy.resolve')}</button></div> : null}
    <div className="connection-detail-authorization-actions"><button className="button small secondary" disabled={loading || writing || authorizationBusy || Boolean(confirmation)} onClick={() => void refresh()}>{t(loading ? 'tenant.metaLegacy.loading' : 'tenant.metaLegacy.refresh')}</button></div>
    {canPrepare && canWrite ? <button className="button primary" disabled={blocked} onClick={create}>{t('tenant.metaLegacy.prepare')}</button> : !view && !loading && !error && canWrite ? <p>{t('tenant.metaLegacy.unavailable')}</p> : null}
    {view ? <div className="meta-legacy-review">
      <dl className="meta-legacy-context"><div><dt>{t('tenant.metaLegacy.source')}</dt><dd><bdi>{name(view.sourceConnection.name)}</bdi></dd></div>
        <div><dt>{t('tenant.metaLegacy.target')}</dt><dd><bdi>{name(view.destinationAccount.label)}</bdi></dd></div></dl>
      <p role="status">{t(`tenant.metaLegacy.state.${view.state}`)}</p>
      <p>{t(`tenant.metaLegacy.payment.${view.destinationAccount.paymentResponsibility}`)}</p>
      {view.capability.qualificationOnly ? <p>{t('tenant.metaLegacy.qualificationOnly')}</p> : null}
      {view.expiresAt ? <p>{t('tenant.metaLegacy.expires')} <time dateTime={view.expiresAt}>{formatDateTime(view.expiresAt, locale)}</time></p> : null}
      {impact}
      {view.reasons.length ? <ul>{view.reasons.map(reason => <li key={reason}>{t(`tenant.metaLegacy.reason.${reason}`)}</li>)}</ul> : null}
      {view.originalRegistration ? <p>{t(`tenant.metaLegacy.outcome.${view.originalRegistration.outcome}`)}</p> : null}
      {view.state === 'RECONCILED_PAUSED' ? <p role="status">{t('tenant.metaLegacy.activation')}</p> : null}
      {view.authorization && canWrite ? <div>
        <button className="button secondary" disabled={loading || writing || authorityLost || authorizationBusy || Boolean(confirmation)} onClick={() => setAuthorizationOpen(value => !value)}>{t(authorizationOpen ? 'tenant.metaLegacy.authorization.hide' : 'tenant.metaLegacy.authorization.open')}</button>
        {authorizationOpen && !authorityLost ? <MetaSignup name={t('tenant.metaLegacy.authorization.name')} mutationHeaders={mutationHeaders} busyChanged={setAuthorizationBusy}
          target={{ connectionId: view.authorization.targetConnectionId, legacyMigrationId: view.authorization.targetLegacyMigrationId, name: name(view.sourceConnection.name), canPrepare: view.authorization.canPrepare, canContinue: view.authorization.canContinue }}
          back={() => { setAuthorizationOpen(false); void refresh(); }} created={() => { setAuthorizationOpen(false); void refresh(); }} /> : null}
      </div> : null}
      <div className="connection-detail-authorization-actions">
        <button className="button secondary" disabled={blocked || !view.actions.observe} onClick={() => action('OBSERVE')}>{t('tenant.metaLegacy.observe')}</button>
        <button className="button primary" disabled={!canRegister} onClick={() => action('REGISTER')}>{t('tenant.metaLegacy.reviewRegister')}</button>
        <button className="button secondary" disabled={blocked || !view.actions.reconcile} onClick={() => action('RECONCILE')}>{t('tenant.metaLegacy.reconcile')}</button>
        <button className="button secondary" disabled={blocked || !view.actions.cancel || view.originalRegistration !== null} onClick={() => action('CANCEL')}>{t('tenant.metaLegacy.cancel')}</button>
      </div>
      {confirmation ? <InlineConfirmation aria-labelledby={confirmationId} cancel={() => setConfirmation(null)} busy={writing}>
        <h4 id={confirmationId}>{t('tenant.metaLegacy.confirmTitle')}</h4><p>{t('tenant.metaLegacy.boundary')}</p>
        <p>{t('tenant.metaLegacy.source')}: <bdi>{name(view.sourceConnection.name)}</bdi></p><p>{t('tenant.metaLegacy.target')}: <bdi>{name(view.destinationAccount.label)}</bdi></p>
        {impact}<p>{t('tenant.metaLegacy.confirmBody')}</p>
        <div className="connection-detail-authorization-actions"><button className="button secondary" data-inline-confirm-initial-focus disabled={writing} onClick={() => setConfirmation(null)}>{t('tenant.metaLegacy.back')}</button>
          <button className="button primary" disabled={!canRegister || writing || confirmation.action !== 'REGISTER' || confirmation.body.expectedRevision !== view.revision || confirmation.body.expectedReviewSha256 !== view.reviewSha256} onClick={() => void run(confirmation)}>{t('tenant.metaLegacy.confirmRegister')}</button></div>
      </InlineConfirmation> : null}
    </div> : null}
  </div>;
}
