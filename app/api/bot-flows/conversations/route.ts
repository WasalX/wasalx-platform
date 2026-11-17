import { getBotConversations } from "../../../../lib/data";
import { BOT_CONVERSATION_PAGE_SIZE } from "../../../../lib/bot-conversations";
import { authenticatePortalRequest, authErrorResponse } from "../../../../lib/request-auth";

export async function GET(request:Request){try{
  await authenticatePortalRequest(request,"bot:read");
  const query=new URL(request.url).searchParams;
  if(query.getAll("cursor").length>1||query.getAll("limit").length>1)throw Object.assign(new Error("Conversation page query is invalid"),{status:400});
  const cursor=query.get("cursor")??undefined;
  const rawLimit=query.get("limit");
  if(rawLimit!==null&&(!/^[1-9][0-9]{0,2}$/u.test(rawLimit)||Number(rawLimit)>100))throw Object.assign(new Error("Conversation page query is invalid"),{status:400});
  const limit=rawLimit===null?BOT_CONVERSATION_PAGE_SIZE:Number(rawLimit);
  return Response.json(await getBotConversations({cursor,limit}),{headers:{"cache-control":"private, no-store"}});
}catch(error){return authErrorResponse(error)}}
