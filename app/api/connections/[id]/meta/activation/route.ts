import {NextResponse} from 'next/server';
import {isControlPlaneBackend,isFixtureBackend} from '../../../../../../lib/backend';
import {getMetaSavedAccessActivation,requestMetaSavedAccessActivation} from '../../../../../../lib/control-plane-data';
import {authenticatePortalRequest,authErrorResponse} from '../../../../../../lib/request-auth';
import {readBoundedJson} from '../../../../../../lib/bounded-json';
import {parseMetaAddAccessActivationRequest} from '../../../../../../packages/core/src/meta-add-access-activation-contract';
type Context={params:Promise<{id:string}>};
const headers={'Cache-Control':'no-store, private, max-age=0',Pragma:'no-cache'};
function id(value:string){if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))throw Object.assign(new Error('Invalid connection'),{status:400});return value;}
export async function GET(request:Request,context:Context){try{
  await authenticatePortalRequest(request,'connection:read');const connectionId=id((await context.params).id);
  if(isFixtureBackend())return NextResponse.json({connectionId,applicable:false,readyToCheck:false,reason:'NOT_APPLICABLE',contextVersion:null,operation:null,providerConfigurationReadback:false,conversationPermission:'SEPARATE_REQUIRED'},{headers});
  if(!isControlPlaneBackend())return NextResponse.json({error:'Saved activation requires the persistent backend.'},{status:501,headers});
  return NextResponse.json(await getMetaSavedAccessActivation(connectionId),{headers});
}catch(error){const response=authErrorResponse(error);Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}}
export async function POST(request:Request,context:Context){try{
  await authenticatePortalRequest(request,'connection:write');const connectionId=id((await context.params).id);
  if(!isControlPlaneBackend())return NextResponse.json({error:'Saved activation requires the persistent backend.'},{status:501,headers});
  let body;try{body=parseMetaAddAccessActivationRequest(await readBoundedJson(new Response(request.body,{headers:request.headers}),4096));}catch{return NextResponse.json({error:'Refresh the saved connection checks.'},{status:400,headers});}
  const key=request.headers.get('idempotency-key');if(!key||key.length>255||key.trim()!==key||/\p{Cc}/u.test(key))return NextResponse.json({error:'Request key is invalid.'},{status:400,headers});
  return NextResponse.json(await requestMetaSavedAccessActivation(connectionId,key,body,request.headers.get('origin')!),{status:202,headers});
}catch(error){const response=authErrorResponse(error);Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}}
