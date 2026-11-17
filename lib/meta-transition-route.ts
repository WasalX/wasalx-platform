import {NextResponse} from 'next/server';
import {isControlPlaneBackend,isFixtureBackend} from './backend';
import {authenticatePortalRequest,authErrorResponse} from './request-auth';
import {readBoundedJson} from './bounded-json';
import {getMetaTransitionPage,getMetaTransitionPreview,requestMetaTransitionPreview} from './control-plane-data';
import {parseMetaTransitionPreviewAction,parseMetaTransitionPreviewRequest,parseMetaTransitionExecutionActionRequest} from '../packages/core/src/meta-account-transition-contract';

const headers={'Cache-Control':'no-store, private, max-age=0',Pragma:'no-cache'};
const uuid=(v:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v);
const executionActions=new Set(['initiate','complete','observe','reconcile']);
export async function metaTransitionRoute(request:Request,id:string,path:string[]=[]){
  try{
    const write=request.method==='POST';await authenticatePortalRequest(request,write?'connection:write':'connection:read');
    const execution=path.length>=2&&executionActions.has(path[1]!);
    if(!uuid(id)||path.length>0&&!uuid(path[0]!)
      ||(write?!(path.length===0||path.length===2&&(['refresh','cancel'].includes(path[1]!)||execution)
        ||path.length===3&&execution&&path[2]==='resolve'):path.length>1))
      return NextResponse.json({error:'Account preview not found.'},{status:404,headers});
    if(!write&&isFixtureBackend()&&path.length===0)return NextResponse.json({prepare:null,currentPlan:null},{headers});
    if(!isControlPlaneBackend())return NextResponse.json({error:'Account previews require the persistent backend.'},{status:501,headers});
    if(!write)return NextResponse.json(path.length?await getMetaTransitionPreview(id,path[0]!):await getMetaTransitionPage(id),{headers});
    let body:unknown;
    try{const raw=await readBoundedJson(new Response(request.body,{headers:request.headers}),4096);
      body=executionActions.has(path[1]??'')?parseMetaTransitionExecutionActionRequest(raw):path.length?parseMetaTransitionPreviewAction(raw):parseMetaTransitionPreviewRequest(raw);
    }catch{return NextResponse.json({error:'Review the account preview request.'},{status:400,headers});}
    const key=request.headers.get('idempotency-key');
    if(executionActions.has(path[1]??'')&&(!key||!uuid(key)))return NextResponse.json({error:'A valid request key is required.'},{status:400,headers});
    if(path[1]!=='cancel'&&(!key||key.length>200))return NextResponse.json({error:'A valid request key is required.'},{status:400,headers});
    return NextResponse.json(await requestMetaTransitionPreview(id,path,body,key),{status:path[1]==='cancel'||path[2]==='resolve'?200:202,headers});
  }catch(error){const response=authErrorResponse(error);for(const [name,value]of Object.entries(headers))response.headers.set(name,value);return response;}
}
