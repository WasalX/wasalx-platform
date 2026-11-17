import {isControlPlaneBackend,isFixtureBackend} from '../../../../../../lib/backend';
import {getMetaCustomerPolicy,requestMetaCustomerPolicy} from '../../../../../../lib/control-plane-data';
import {authenticatePortalRequest,authErrorResponse} from '../../../../../../lib/request-auth';
import {parseMetaPolicySelection,parseMetaTariffQuery,isMetaPolicyAcceptanceResult} from '../../../../../../packages/core/src/meta-billing-policy-contract';
import {readBoundedJson} from '../../../../../../lib/bounded-json';
type Context={params:Promise<{id:string}>};
const headers={'Cache-Control':'no-store, private, max-age=0',Pragma:'no-cache'};
export async function GET(request:Request,context:Context){try{
  const search=new URL(request.url).searchParams;let query;
  try{if(new Set(search.keys()).size!==Array.from(search.keys()).length)throw new Error('Duplicate query');query=parseMetaTariffQuery(Object.fromEntries(search));}
  catch{return Response.json({error:'Refresh the available rates.'},{status:400,headers});}
  const principal=await authenticatePortalRequest(request,query?'connection:write':'connection:read');
  if(!contextMatches(request,principal))return Response.json({error:'Payment context changed.'},{status:403,headers});
  if(isFixtureBackend())return Response.json({enrolled:false,mode:null,revision:0,sendReady:false,paymentMethod:'UNAVAILABLE',checkedAt:null,actualPayer:'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:false,state:null},{headers});
  if(!isControlPlaneBackend())return Response.json({error:'Payment settings require the persistent backend.'},{status:501,headers});
  return Response.json(await getMetaCustomerPolicy((await context.params).id,query),{headers});
}catch(error){const response=authErrorResponse(error);Object.entries(headers).forEach(([k,v])=>response.headers.set(k,v));return response;}}
export async function POST(request:Request,context:Context){let forwarded=false;try{
  const principal=await authenticatePortalRequest(request,'connection:write');
  if(!contextMatches(request,principal))return Response.json({error:'Payment context changed.'},{status:403,headers});
  if(!isControlPlaneBackend())return Response.json({error:'Payment settings require the persistent backend.'},{status:501,headers});
  let v:unknown;try{v=await readBoundedJson(new Response(request.body,{headers:request.headers}),4096);}catch{return Response.json({error:'A valid payment request is required.'},{status:400,headers});}
  let body;try{body=parseMetaPolicySelection(v);}catch{return Response.json({error:'Select an available payment option and review its terms.'},{status:400,headers});}
  const key=request.headers.get('idempotency-key');
  if(!key||((body.mode==='MANAGED'||'tariffVersionId' in body)&&!/^[A-Za-z0-9._:-]{1,128}$/u.test(key)))return Response.json({error:'A valid request key is required.'},{status:400,headers});
  forwarded=true;const result=await requestMetaCustomerPolicy((await context.params).id,key,body);
  if(!isMetaPolicyAcceptanceResult(body,result))return Response.json({error:'The payment request outcome is unavailable.'},{status:502,headers});
  return Response.json(result,{status:202,headers});
 }catch(error){
  if(forwarded){const value=error as {status?:unknown;code?:unknown};const status=typeof value?.status==='number'&&Number.isInteger(value.status)&&value.status>=400&&value.status<=599?value.status:502;
   return Response.json({error:'The payment request could not be completed.',...(value?.code==='REAUTHENTICATION_REQUIRED'?{code:value.code}:{})},{status,headers});}
  const response=authErrorResponse(error);Object.entries(headers).forEach(([k,v])=>response.headers.set(k,v));return response;
 }}

// Old callers may omit both hints. A retained browser intent supplies both;
// neither can override the current authenticated session or its permission.
function contextMatches(request:Request,principal:{userId:string;tenantId:string}){
 const actor=request.headers.get('x-wasalx-billing-actor'),tenant=request.headers.get('x-wasalx-billing-workspace');
 return actor===null&&tenant===null||actor===encodeURIComponent(principal.userId)&&tenant===encodeURIComponent(principal.tenantId);
}
