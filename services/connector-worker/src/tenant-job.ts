import { ServiceAuthenticationError, verifyServiceJwt } from "../../../packages/core/src/service-auth.js";
import { DIRECT_TICKET_READ_SCOPE, type DirectTicketRead } from "../../../packages/core/src/delivery.js";
import type { DrainJob } from "./types.js";

export async function verifyDrainJob(value:unknown,secret:string,scope="delivery:drain"):Promise<DrainJob>{
  if(!value||typeof value!=="object")throw new ServiceAuthenticationError("Malformed drain job");
  const input=value as Partial<DrainJob>;
  if(typeof input.tenantId!=="string"||typeof input.token!=="string")throw new ServiceAuthenticationError("Malformed drain job");
  const claims = await verifyServiceJwt(input.token,secret,{issuer:"wasalx-control",audience:"wasalx-connector-worker",scope,tenantId:input.tenantId});
  if (scope === DIRECT_TICKET_READ_SCOPE) {
    const read = (claims as typeof claims & { direct_ticket_read?: Partial<DirectTicketRead> }).direct_ticket_read;
    const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
    const nativeId = /^[1-9][0-9]{0,15}$/u;
    if (claims.sub !== "direct-ticket-read" || !read || !uuid.test(input.tenantId) || !uuid.test(claims.instance_id) ||
        read.instanceId !== claims.instance_id || typeof read.connectionId !== "string" || !uuid.test(read.connectionId) ||
        [read.actorId, read.ticketId, read.customerId].some(id => typeof id !== "string" || !nativeId.test(id)) ||
        typeof read.openedAt !== "number" || !Number.isSafeInteger(read.openedAt) ||
        read.openedAt < claims.iat * 1000 - 120_000 || read.openedAt > claims.iat * 1000 + 6_000) {
      throw new ServiceAuthenticationError("Malformed direct ticket read");
    }
    return { tenantId: input.tenantId, token: input.token, directTicketRead: read as DirectTicketRead };
  }
  if (claims.scope.split(" ").includes(DIRECT_TICKET_READ_SCOPE)) throw new ServiceAuthenticationError("Direct ticket read has an invalid scope");
  if(input.metaTransitionEventIds!==undefined&&(scope!=="delivery:drain"||!Array.isArray(input.metaTransitionEventIds)
    ||input.metaTransitionEventIds.length>32||input.metaTransitionEventIds.some(id=>typeof id!=="string"||!(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).test(id))))throw new ServiceAuthenticationError("Malformed transition wake");
  return{tenantId:input.tenantId,token:input.token,...(input.metaTransitionEventIds?{metaTransitionEventIds:[...new Set(input.metaTransitionEventIds)]}:{})};
}
