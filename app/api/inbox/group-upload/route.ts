import { inboxUpload } from "../../../../lib/inbox-upload";
export const POST = (request: Request) => inboxUpload(request, true);
