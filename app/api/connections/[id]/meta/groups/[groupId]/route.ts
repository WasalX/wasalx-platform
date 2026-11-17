import { metaGroupsRoute } from "../../../../_meta-groups";

export const PUT = (
  request: Request,
  context: { params: Promise<{ id: string; groupId: string }> },
) => metaGroupsRoute(request, context, "update");
