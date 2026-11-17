import { metaGroupsRoute } from "../../../../../_meta-groups";

export const GET = (
  request: Request,
  context: { params: Promise<{ id: string; groupId: string }> },
) => metaGroupsRoute(request, context, "invite-link");
