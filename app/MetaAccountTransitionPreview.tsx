"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {MetaSignup} from './MetaSignup';
import {useI18n} from './I18nProvider';
import {useDeadlineCurrent} from './use-deadline-current';
import {useVisibleRefresh} from './use-visible-refresh';
import {createLatestRequestFence} from '../lib/operator-ui';
import {formatDateTime} from '../lib/i18n/format';
import {readBoundedJson} from '../lib/bounded-json';
import {localizedUiError,type UiErrorCode} from '../lib/ui-error';
import {isMetaTransitionExecutionView,metaTransitionIntentKey,metaTransitionIntentSettled,metaTransitionPendingActionMatches,parseMetaTransitionIntent,type MetaTransitionIntent} from '../lib/meta-transition-intent';
import {isMetaTransitionCurrency,type MetaTransitionPreviewPage,type MetaTransitionPreviewView,type MetaTransitionRequestedMode,type MetaTransitionExecutionAction} from '../packages/core/src/meta-account-transition-contract';

type Props={connectionId:string;canConfigure:boolean;mutationHeaders:Record<string,string>;refreshKey:number};
const executionActions=['initiate','complete','observe','reconcile'] as const;
type ExecutionAction=typeof executionActions[number];
const executionReasons=new Set(['PREREQUISITES_UNVERIFIED','AUTHORIZATION_EXPIRED','SCOPE_CHANGED','IN_FLIGHT_EFFECTS','PROVIDER_OUTCOME_UNRESOLVED',
  'TARGET_PROOF_REQUIRED','PAYMENT_ACTION_REQUIRED','TEMPLATE_ACTION_REQUIRED','IDENTITY_ACTION_REQUIRED','RUNTIME_UNQUALIFIED','PRIVACY_HOLD','CURRENT_PERMISSION_REQUIRED','STAGE_ALREADY_ATTEMPTED']);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v);
const previewIsCurrent=(expiresAt:unknown)=>typeof expiresAt==='string'&&Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>Date.now();
export function MetaAccountTransitionPreview(props:Props){
  // Refresh preserves drafts; scope/authority changes unmount the request lifetime.
  return <Preview key={`${props.connectionId}:${props.canConfigure}:${JSON.stringify(props.mutationHeaders)}`} {...props}/>;
}
function Preview({connectionId,canConfigure,mutationHeaders,refreshKey}:Props){
  const {t,locale}=useI18n(),path=`/api/connections/${encodeURIComponent(connectionId)}/meta/account-transitions`;
  const [page,setPage]=useState<MetaTransitionPreviewPage|null>(null),[loading,setLoading]=useState(true),[sending,setSending]=useState(false);
  const [error,setError]=useState<{code:UiErrorCode;message:string}|null>(null);
  const [hold,setHold]=useState<MetaTransitionIntent|null>(null),[storageBlocked,setStorageBlocked]=useState(false);
  const [renewal,setRenewal]=useState<{planId:string;connectionId:string;name:string}|null>(null);
  const [renewalBusy,setRenewalBusy]=useState(false);
  const [acceptedTerms,setAcceptedTerms]=useState<string|null>(null);
  const [mode,setMode]=useState<MetaTransitionRequestedMode>('CUSTOMER'),[currency,setCurrency]=useState('');
  const fence=useRef(createLatestRequestFence()),active=useRef<AbortController|null>(null),busy=useRef(false),currentPlan=useRef<string|null>(null);
  const intent=useRef<{route:string;body:string;key:string}|null>(null);
  const view=page?.currentPlan??null,execution=view?.execution;
  const renewalOpen=renewal!==null&&renewal.planId===view?.id;
  const renewalCurrent=renewalOpen?execution?.renewals.find(item=>item.connectionId===renewal.connectionId):undefined;
  const terms=execution?.requestedMode==='WASALX_MANAGED'?execution.terms:null;
  const termsKey=view&&execution?.previewSha256&&terms?JSON.stringify([view.id,execution.revision,execution.previewSha256,terms.documentSha256]):null;
  const managedTermsAccepted=execution?.requestedMode!=='WASALX_MANAGED'||termsKey!==null&&acceptedTerms===termsKey;
  const pending=view?.state==='PENDING'||execution?.pendingAction?.state==='QUEUED'||execution?.pendingAction?.state==='RUNNING';
  const canCancel=execution?execution.actions.cancel:view?.canCancel===true;
  const canPrepare=Boolean(page?.prepare)&&(!view||view.state==='CANCELLED'||execution?.state==='RECONCILED_PAUSED');
  const label=(key:string)=>t(`tenant.connection.accountPreview.${key}`);

  const request=useCallback(async(url:string,controller:AbortController,init?:RequestInit)=>{
    // Caller cancellation and the deadline both remain active for reads and writes.
    const timeout=setTimeout(()=>controller.abort(),20_000);
    try{const response=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
      const body=await readBoundedJson(response,524_288) as Record<string,unknown>;
      if(!response.ok)throw Object.assign(new Error('Account preview unavailable'),{status:response.status,code:typeof body?.code==='string'?body.code:undefined});
      return body;
    }finally{clearTimeout(timeout);}
  },[]);
  const load=useCallback(async(planId?:string,signal?:AbortSignal)=>{
    const generation=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;setLoading(true);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      const [rawPage,rawExact]=await Promise.all([request(path,controller),planId?request(`${path}/${encodeURIComponent(planId)}`,controller):Promise.resolve(null)]);
      const result=rawPage as unknown as MetaTransitionPreviewPage;
      if(!result||typeof result!=='object'||!('currentPlan' in result)||!('prepare' in result))throw new Error('Account preview unavailable');
      if(planId){const exact=rawExact as unknown as MetaTransitionPreviewView;
        if(exact.id!==planId||exact.canExecute!==false)throw new Error('Account preview changed');result.currentPlan=exact;}
      const next=result.currentPlan;
      if(next!==null&&(!uuid(next.id)||next.canExecute!==false||next.execution!==undefined&&!isMetaTransitionExecutionView(next.execution)))throw new Error('Account preview unavailable');
      if(!fence.current.isCurrent(generation))return;
      let saved:MetaTransitionIntent|null=null;
      try{if(next){const key=metaTransitionIntentKey(connectionId,next.id);saved=parseMetaTransitionIntent(window.sessionStorage.getItem(key));
        if(saved&&metaTransitionIntentSettled(saved,next.execution)){window.sessionStorage.removeItem(key);saved=null;}}
        setStorageBlocked(false);
      }catch{setStorageBlocked(true);}
      currentPlan.current=next?.id??null;setPage(result);setHold(saved);setError(null);intent.current=null;
    }catch(value){if(fence.current.isCurrent(generation)&&!signal?.aborted){const safe=localizedUiError(locale,value);setError(safe);
      if(safe.code==='UNAUTHENTICATED'||safe.code==='FORBIDDEN'||safe.code==='NOT_FOUND'){setPage(null);setAcceptedTerms(null);}}}
    finally{signal?.removeEventListener('abort',abort);if(fence.current.isCurrent(generation)){setLoading(false);setSending(false);busy.current=false;}}
  },[path,request,locale,connectionId]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),0),owned=fence.current;return()=>{clearTimeout(timer);owned.invalidate();active.current?.abort();};},[load,refreshKey]);
  // Keep the incumbent refresh interval longer than the combined read deadline.
  useVisibleRefresh(signal=>{if(!busy.current)return load(currentPlan.current??undefined,signal);},!sending);

  async function mutate(action:'create'|'refresh'|'cancel'){
    if(renewalOpen||!canConfigure||busy.current||loading||error||hold||storageBlocked||pending&&action!=='cancel')return;
    if(action==='create'&&(!canPrepare||!isMetaTransitionCurrency(currency)))return;
    if(action!=='create'&&(!view||(action==='refresh'?!view.canRefresh:!canCancel)))return;
    busy.current=true;setSending(true);setError(null);
    const route=action==='create'?path:`${path}/${encodeURIComponent(view!.id)}/${action}`;
    const body=JSON.stringify(action==='create'?{requestedMode:mode,targetCurrency:currency,expectedAccountRevision:page!.prepare!.accountRevision,expectedBindingRevision:page!.prepare!.bindingRevision}:{expectedRevision:view!.revision});
    if(!intent.current||intent.current.route!==route||intent.current.body!==body)intent.current={route,body,key:crypto.randomUUID()};
    const frozen=intent.current,generation=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;
    try{const result=await request(frozen.route,controller,{method:'POST',headers:{...mutationHeaders,'content-type':'application/json','idempotency-key':frozen.key},body:frozen.body});
      if(!uuid(result.id)||action!=='create'&&result.id!==view!.id)throw new Error('Account preview changed');
      if(!fence.current.isCurrent(generation))return;
      currentPlan.current=result.id;await load(result.id);
    }catch(value){if(fence.current.isCurrent(generation)){setError(localizedUiError(locale,value));setSending(false);busy.current=false;}}
  }
  async function execute(action:ExecutionAction){
    if(renewalOpen||!canConfigure||busy.current||loading||pending||error||hold||storageBlocked||!view||!execution||!execution.previewSha256||execution.actions[action]!==true)return;
    if(action==='initiate'&&(!managedTermsAccepted||!previewIsCurrent(view.expiresAt)))return;
    if(action==='initiate'||action==='complete'){
      const confirmed=window.confirm(t(`tenant.connection.accountPreview.execution.confirm.${action}`,{
        count:execution.impactConnectionCount,from:`\u2068${execution.sourceCurrency??label('unknown')}\u2069`,to:`\u2068${execution.targetCurrency}\u2069`,mode:label(`mode.${execution.requestedMode}`)}));
      if(!confirmed)return;
    }
    const frozen:MetaTransitionIntent={schemaVersion:1,action:action.toUpperCase() as MetaTransitionExecutionAction,requestRevision:execution.revision,
      previewSha256:execution.previewSha256,key:crypto.randomUUID(),operationId:null};
    const storageKey=metaTransitionIntentKey(connectionId,view.id),planId=view.id;
    try{window.sessionStorage.setItem(storageKey,JSON.stringify(frozen));}catch{setStorageBlocked(true);return;}
    busy.current=true;setSending(true);setHold(frozen);setError(null);
    const generation=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;
    try{const result=await request(`${path}/${encodeURIComponent(planId)}/${action}`,controller,{method:'POST',headers:{...mutationHeaders,'content-type':'application/json','idempotency-key':frozen.key},
      body:JSON.stringify({expectedRevision:frozen.requestRevision,expectedPreviewSha256:frozen.previewSha256})});
      if(result.id!==planId||!uuid(result.operationId)||typeof result.duplicate!=='boolean')throw new Error('Account change result unavailable');
      if(!fence.current.isCurrent(generation))return;
      const acknowledged={...frozen,operationId:result.operationId};window.sessionStorage.setItem(storageKey,JSON.stringify(acknowledged));setHold(acknowledged);
    }catch(value){if(!fence.current.isCurrent(generation))return;setError(localizedUiError(locale,value));}
    if(fence.current.isCurrent(generation))await load(planId); // Read-only recovery; never repeat a POST.
  }
  async function resolvePending(){
    if(renewalOpen||!canConfigure||busy.current||loading||error||storageBlocked||!view||!hold)return;
    const frozen={...hold},planId=view.id,storageKey=metaTransitionIntentKey(connectionId,planId);
    busy.current=true;setSending(true);setError(null);
    const generation=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;
    try{
      const result=await request(`${path}/${encodeURIComponent(planId)}/${frozen.action.toLowerCase()}/resolve`,controller,{method:'POST',
        headers:{...mutationHeaders,'content-type':'application/json','idempotency-key':frozen.key},
        body:JSON.stringify({expectedRevision:frozen.requestRevision,expectedPreviewSha256:frozen.previewSha256})});
      if(result.id!==planId||!uuid(result.operationId)||typeof result.duplicate!=='boolean'
        ||!metaTransitionPendingActionMatches(frozen,result.pendingAction)||result.pendingAction.operationId!==result.operationId)throw new Error('Account change result unavailable');
      if(!fence.current.isCurrent(generation))return;
      if(['SUCCEEDED','FAILED_TERMINAL','CANCELLED'].includes(result.pendingAction.state)){
        window.sessionStorage.removeItem(storageKey);setHold(null);
      }else{const saved={...frozen,operationId:result.operationId};window.sessionStorage.setItem(storageKey,JSON.stringify(saved));setHold(saved);}
    }catch(value){if(!fence.current.isCurrent(generation))return;setError(localizedUiError(locale,value));}
    if(fence.current.isCurrent(generation))await load(planId);
  }
  function submit(event:FormEvent){event.preventDefault();void mutate('create');}
  const disabled=loading||sending,mutationDisabled=disabled||renewalOpen||Boolean(error)||Boolean(hold)||storageBlocked;
  const providerActionExpired=!useDeadlineCurrent(view?.expiresAt);
  return <section className="connection-detail-section" aria-labelledby={`account-preview-${connectionId}`}>
    <div className="connection-detail-section-head"><div><h3 id={`account-preview-${connectionId}`}>{label('title')}</h3><p>{label('body')}</p></div></div>
    <p className="connection-detail-note">{label('boundary')}</p>
    <p role="status" aria-live="polite" className="connection-detail-note">{loading?label('loading'):view?label(`state.${view.state}`):canConfigure&&canPrepare&&!error?label('empty'):null}</p>
    {!loading&&!page?.prepare&&!view&&!error?<p className="connection-detail-note">{label('enrollFirst')}</p>:null}
    {view?<>
      <dl className="connection-detail-note"><dt>{label('current')}</dt><dd>{label(`mode.${view.current.declaredMode}`)} · <bdi>{view.current.currency??label('unknown')}</bdi></dd>
        <dt>{label('requested')}</dt><dd>{label(`mode.${view.requestedMode}`)} · <bdi>{view.targetCurrency}</bdi></dd>
        <dt>{label('actualPayer')}</dt><dd>{label('unknown')}</dd>
        <dt>{label('sourceTemplates')}</dt><dd><bdi>{view.impact.sourceTemplateCount??label('unknown')}</bdi></dd>
        <dt>{label('affectedFlows')}</dt><dd><bdi>{view.impact.affectedFlowVersionCount??label('unknown')}</bdi></dd></dl>
      <p className="connection-detail-note">{label('compatibilityNotAssessed')}</p>
      <h4>{label('affected')}</h4><ul>{view.impact.connections.map(connection=><li key={connection.id}><bdi>{connection.name??label('unavailableConnection')}</bdi></li>)}</ul>
      <p className="connection-detail-note">{label(`inventory.${view.impact.phoneInventory}`)}{view.impact.externalPhoneCount!==null?` ${t('tenant.connection.accountPreview.externalCount',{count:view.impact.externalPhoneCount})}`:''}</p>
      {view.reasons.length?<><h4>{label('prerequisites')}</h4><ul>{view.reasons.map(reason=><li key={reason}>{label(`reason.${reason}`)}</li>)}</ul></>:null}
      <p className="connection-detail-note">{label('snapshot')}</p>
      {execution?<div aria-labelledby={`account-execution-${connectionId}`}>
        <h4 id={`account-execution-${connectionId}`}>{label('execution.title')}</h4>
        <p role="status" aria-live="polite" className="connection-detail-note">{label(`execution.state.${execution.state}`)}</p>
        <p className="connection-detail-note">{label('execution.boundary')}</p>
        {execution.completionApprovalRequired?<p className="connection-detail-note">{label('execution.renewal.approval')}</p>:null}
        {execution.renewals.length?<div>
          <h4>{label('execution.renewal.title')}</h4><p className="connection-detail-note">{label('execution.renewal.body')}</p>
          <ul>{execution.renewals.map(source=><li key={source.connectionId}><bdi>{source.name}</bdi>{' '}
            <span>{label(`execution.renewal.access.${source.access}`)}</span>{' '}
            {canConfigure?<button type="button" className="button small secondary" disabled={disabled||renewalBusy||Boolean(error)}
              onClick={()=>setRenewal({planId:view.id,connectionId:source.connectionId,name:source.name})}>{label('execution.renewal.open')}</button>:null}
          </li>)}</ul>
        </div>:null}
        {renewalOpen&&canConfigure?<MetaSignup name={t('tenant.metaSignup.readback.title')} mutationHeaders={mutationHeaders}
          target={{connectionId:renewal.connectionId,transitionId:renewal.planId,name:renewalCurrent?.name??renewal.name,
            canPrepare:!disabled&&!error&&renewalCurrent?.canPrepare===true,canContinue:!error&&renewalCurrent?.canPrepare===true}}
          busyChanged={setRenewalBusy} back={()=>{setRenewal(null);void load(view.id);}}
          created={()=>{setRenewal(null);void load(view.id);}}/>:null}
        {execution.requestedMode==='WASALX_MANAGED'?(terms?<>
          <details className="connection-detail-note" open><summary>{label('execution.terms.title')}</summary>
            <p>{label('execution.terms.version')}: <bdi>{terms.version}</bdi></p>
            <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{terms.documentText}</p>
          </details>
          {canConfigure&&execution.actions.initiate?<label className="check"><input type="checkbox" checked={termsKey!==null&&acceptedTerms===termsKey}
            disabled={mutationDisabled||!termsKey||providerActionExpired} onChange={event=>setAcceptedTerms(event.target.checked?termsKey:null)}/>
            <span>{label('execution.terms.accept')}</span></label>:null}
        </>:<p className="connection-detail-note">{label('execution.terms.unavailable')}</p>):null}
        <p className="connection-detail-note">{t('tenant.connection.accountPreview.execution.impact',{count:execution.impactConnectionCount})}</p>
        <dl className="connection-detail-note"><dt>{label('execution.providerStatus')}</dt><dd>{execution.providerStatus?label(`execution.provider.${execution.providerStatus}`):label('unknown')}</dd>
          <dt>{label('execution.observedAt')}</dt><dd>{execution.observedAt?formatDateTime(execution.observedAt,locale):label('unknown')}</dd></dl>
        {execution.reasons.length?<ul>{execution.reasons.map((reason,index)=><li key={`${reason}:${index}`}>{label(`execution.reason.${executionReasons.has(reason)?reason:'UNKNOWN'}`)}</li>)}</ul>:null}
        {execution.history.length?<><h4>{label('execution.history')}</h4><ul>{execution.history.map((entry,index)=><li key={`${entry.stage}:${entry.attemptedAt}:${index}`}>
          {label(`execution.action.${entry.stage.toLowerCase()}`)} · {label(`execution.outcome.${entry.outcome}`)} · {formatDateTime(entry.attemptedAt,locale)}
        </li>)}</ul></>:null}
        {hold?<><p role="status" aria-live="polite" className="connection-detail-note">{label('execution.heldRequest')}</p>
          {canConfigure?<><p className="connection-detail-note">{label('execution.resolveHelp')}</p><button type="button" className="button secondary"
            disabled={disabled||renewalOpen||storageBlocked||Boolean(error)} onClick={()=>void resolvePending()}>{label('execution.resolve')}</button></>:null}</>:null}
        {canConfigure?<div className="connection-detail-actions">{executionActions.map(action=><button key={action} type="button" className="button secondary"
          disabled={mutationDisabled||pending||!execution.previewSha256||!execution.actions[action]||(action==='initiate'&&(providerActionExpired||!managedTermsAccepted))}
          onClick={()=>void execute(action)}>{label(`execution.action.${action}`)}</button>)}</div>:null}
        <button type="button" className="button small secondary" disabled={disabled} onClick={()=>void load(view.id)}>{label('checkStatus')}</button>
      </div>:null}
      {canConfigure?<div className="connection-detail-actions"><button type="button" className="button secondary" disabled={mutationDisabled||!view.canRefresh} onClick={()=>void mutate('refresh')}>{label('refresh')}</button>
        <button type="button" className="button secondary" disabled={mutationDisabled||!canCancel} onClick={()=>void mutate('cancel')}>{label('cancel')}</button></div>:null}
    </>:null}
    {canConfigure&&canPrepare?<form onSubmit={submit}>
      <label className="field"><span>{label('payer')}</span><select value={mode} disabled={mutationDisabled} onChange={event=>setMode(event.target.value as MetaTransitionRequestedMode)}>
        <option value="CUSTOMER">{label('mode.CUSTOMER')}</option><option value="WASALX_MANAGED">{label('mode.WASALX_MANAGED')}</option></select></label>
      <label className="field"><span>{label('currency')}</span><input dir="ltr" value={currency} disabled={mutationDisabled} maxLength={3} pattern="[A-Z]{3}" autoCapitalize="characters" autoComplete="off" required
        aria-describedby={`preview-currency-help-${connectionId}`} onChange={event=>setCurrency(event.target.value.toUpperCase())}/></label>
      <p id={`preview-currency-help-${connectionId}`} className="connection-detail-note">{label('currencyHelp')}</p>
      <button type="submit" className="button secondary" disabled={mutationDisabled||!isMetaTransitionCurrency(currency)}>{label('prepare')}</button>
    </form>:null}
    {storageBlocked?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><p>{label('execution.storageUnavailable')}</p>
      <button type="button" className="button small secondary" disabled={disabled} onClick={()=>void load(currentPlan.current??undefined)}>{label('checkStatus')}</button></div>:null}
    {error?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><div><p>{error.message}</p><p>{label('recover')}</p>
      {error.code==='REAUTHENTICATION_REQUIRED'?<a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${connectionId}`)}`}>{t('tenant.connection.reauthenticate')}</a>:null}</div>
      <button type="button" className="button small secondary" disabled={disabled} onClick={()=>void load(currentPlan.current??undefined)}>{label('checkStatus')}</button></div>:null}
  </section>;
}
