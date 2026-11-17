import { metaGroupsRoute } from "../../../_meta-groups";

export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  metaGroupsRoute(request, context, "create");
