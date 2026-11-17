export type NumberReleaseBody = {routeId:string;phoneNumberId:string;disconnectOperationId:string};
export type NumberReleaseView = {routeId:string;phoneNumberId:string;disconnectOperationId:string|null;releaseId:string|null;state:string;reconnectRequiresNewConnection:true};
export type NumberReleaseIntent = {version:1;tenantId:string;actorId:string;connectionId:string;key:string;body:NumberReleaseBody;uncertain:boolean;acknowledgmentId:string|null};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const phone=(value:unknown):value is string=>typeof value==='string'&&value.trim()===value&&/^\d{5,32}$/u.test(value);
export const numberReleaseIntentKey=(tenant:string,actor:string,connection:string)=>`wasalx.meta.number-release:${JSON.stringify([tenant,actor,connection])}`;
export const sameNumberReleaseBody=(a:NumberReleaseBody,b:NumberReleaseBody)=>a.routeId===b.routeId&&a.phoneNumberId===b.phoneNumberId&&a.disconnectOperationId===b.disconnectOperationId;
export const numberReleaseReadbackMatches=(intent:NumberReleaseIntent,view:NumberReleaseView)=>Boolean(view.releaseId&&view.disconnectOperationId
  &&sameNumberReleaseBody(intent.body,{routeId:view.routeId,phoneNumberId:view.phoneNumberId,disconnectOperationId:view.disconnectOperationId})
  &&(!intent.acknowledgmentId||intent.acknowledgmentId===view.releaseId));
export function parseNumberReleaseBody(value:unknown):NumberReleaseBody{
  if(!object(value)||Object.keys(value).sort().join(',')!=='disconnectOperationId,phoneNumberId,routeId'
    ||!uuid(value.routeId)||!uuid(value.disconnectOperationId)||!phone(value.phoneNumberId))throw new Error('NUMBER_RELEASE_INVALID');
  return {routeId:value.routeId,phoneNumberId:value.phoneNumberId,disconnectOperationId:value.disconnectOperationId};
}
export function parseNumberReleaseView(value:unknown):NumberReleaseView{
  if(!object(value)||!uuid(value.routeId)||!phone(value.phoneNumberId)||(value.disconnectOperationId!==null&&!uuid(value.disconnectOperationId))
    ||(value.releaseId!==null&&(!uuid(value.releaseId)||value.disconnectOperationId===null))||value.state!=='REVOKED'||value.reconnectRequiresNewConnection!==true)throw new Error('NUMBER_RELEASE_INVALID');
  return {routeId:value.routeId,phoneNumberId:value.phoneNumberId,disconnectOperationId:value.disconnectOperationId,releaseId:value.releaseId,state:value.state,reconnectRequiresNewConnection:true};
}
export function parseNumberReleaseAcknowledgment(value:unknown):string{
  if(!object(value)||!uuid(value.id)||value.released!==true||typeof value.duplicate!=='boolean'||value.reconnectRequiresNewConnection!==true)throw new Error('NUMBER_RELEASE_INVALID');
  return value.id;
}
/** Non-secret request identity only. Corrupt storage holds writes; it never creates a replacement key. */
export function parseNumberReleaseIntent(raw:string|null,tenantId:string,actorId:string,connectionId:string):NumberReleaseIntent|null{
  if(raw===null)return null;
  if(raw.length>4096)throw new Error('NUMBER_RELEASE_STORAGE');
  const value:unknown=JSON.parse(raw);
  if(!object(value)||Object.keys(value).sort().join(',')!=='acknowledgmentId,actorId,body,connectionId,key,tenantId,uncertain,version'
    ||value.version!==1||value.tenantId!==tenantId||value.actorId!==actorId||value.connectionId!==connectionId||!uuid(value.key)||typeof value.uncertain!=='boolean'
    ||(value.acknowledgmentId!==null&&!uuid(value.acknowledgmentId))||(!value.uncertain&&value.acknowledgmentId!==null))throw new Error('NUMBER_RELEASE_STORAGE');
  return {version:1,tenantId,actorId,connectionId,key:value.key,body:parseNumberReleaseBody(value.body),uncertain:value.uncertain,acknowledgmentId:value.acknowledgmentId};
}
