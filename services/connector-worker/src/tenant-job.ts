import { ServiceAuthenticationError, verifyServiceJwt } from "../../../packages/core/src/service-auth.js";
import type { DrainJob } from "./types.js";

export async function verifyDrainJob(value:unknown,secret:string,scope="delivery:drain"):Promise<DrainJob>{
  if(!value||typeof value!=="object")throw new ServiceAuthenticationError("Malformed drain job");
  const input=value as Partial<DrainJob>;
  if(typeof input.tenantId!=="string"||typeof input.token!=="string")throw new ServiceAuthenticationError("Malformed drain job");
  await verifyServiceJwt(input.token,secret,{issuer:"wasalx-control",audience:"wasalx-connector-worker",scope,tenantId:input.tenantId});
  if(input.metaTransitionEventIds!==undefined&&(scope!=="delivery:drain"||!Array.isArray(input.metaTransitionEventIds)
    ||input.metaTransitionEventIds.length>32||input.metaTransitionEventIds.some(id=>typeof id!=="string"||!(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).test(id))))throw new ServiceAuthenticationError("Malformed transition wake");
  return{tenantId:input.tenantId,token:input.token,...(input.metaTransitionEventIds?{metaTransitionEventIds:[...new Set(input.metaTransitionEventIds)]}:{})};
}
