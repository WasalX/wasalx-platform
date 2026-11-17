import type { FastifyRequest } from "fastify";
import type { TenantRole } from "./rbac.js";
export type Principal={subject:string;userId:string;tenantId:string;email:string;displayName:string;role:TenantRole;authenticatedAt?:number;authenticationMethods?:string[];authenticationContext?:string};
export type AuthenticatedRequest=FastifyRequest&{principal:Principal};
