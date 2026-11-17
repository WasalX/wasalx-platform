import {metaTransitionRoute} from '../../../../../../../lib/meta-transition-route';
type Context={params:Promise<{id:string;path:string[]}>};
export async function GET(request:Request,context:Context){const {id,path}=await context.params;return metaTransitionRoute(request,id,path);}
export async function POST(request:Request,context:Context){const {id,path}=await context.params;return metaTransitionRoute(request,id,path);}
