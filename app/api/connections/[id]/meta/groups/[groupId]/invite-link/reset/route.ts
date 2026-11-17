import { metaGroupsRoute } from "../../../../../../_meta-groups";

export const POST = (
  request: Request,
  context: { params: Promise<{ id: string; groupId: string }> },
) => metaGroupsRoute(request, context, "reset-invite-link");
