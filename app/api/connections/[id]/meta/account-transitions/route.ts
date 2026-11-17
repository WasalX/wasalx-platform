import {metaTransitionRoute} from '../../../../../../lib/meta-transition-route';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){return metaTransitionRoute(request,(await context.params).id);}
export async function POST(request:Request,context:Context){return metaTransitionRoute(request,(await context.params).id);}
