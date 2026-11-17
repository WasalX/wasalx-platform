import {BadRequestException,ConflictException,Injectable,ServiceUnavailableException} from "@nestjs/common";
import {createHash} from "node:crypto";
import {MetaCredentialService} from "./meta-credential.service.js";
import {MetaGroupsClientFactory} from "./meta-groups.client.js";
import {WebhookSecretService} from "./webhook-secret.service.js";
import {PlatformOperationsRepository} from "./platform-operations.repository.js";
import type {PlatformOperatorPrincipal} from "./tenant-provisioning.types.js";

/** SIMULATED software approval only. No enrollment, line purchase, provider
 * mutation or LIVE mode selector. Business-management scope alone is not a
 * financial role grant: the separate restricted approval digest binds the
 * independently reviewed holder/editor authority and exact account scope. */
@Injectable()
export class MetaManagedApprovalService {
 constructor(private readonly repository:PlatformOperationsRepository,private readonly credentials:MetaCredentialService,
  private readonly clients:MetaGroupsClientFactory,private readonly appSecrets:WebhookSecretService){}
 async approveSimulated(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new BadRequestException("Managed approval is invalid.");
  const body=input as Record<string,unknown>;
  const fields=["tenantId","accountId","familyId","kind","holderBusinessId","creditLineId","solutionId","receivingBusinessId","requestedCurrency","commercialTermsVersionId","approvalSha256","expiresAt"];
  if(Object.keys(body).length!==fields.length||Object.keys(body).some(key=>!fields.includes(key)))throw new BadRequestException("Managed approval is invalid.");
  if(typeof body.tenantId!=="string"||typeof body.accountId!=="string")throw new BadRequestException("Managed approval is invalid.");
  const appId=process.env.META_APP_ID??"",secretReference=process.env.META_FINANCIAL_SECRET_REFERENCE??"",appSecretReference=process.env.META_APP_SECRET_REFERENCE??"";
  if(!/^[0-9]{1,32}$/u.test(appId)||!secretReference||!appSecretReference)throw new ServiceUnavailableException("Financial access is not configured.");
  const binding=await this.repository.metaManagedApprovalContext(body.tenantId,body.accountId,operator,requestId);
  if(binding.appId!==appId)throw new ConflictException("Account approval changed.");
  const token=await this.credentials.resolveFinancialAccessToken();
  const appSecret=await this.appSecrets.resolveHmac(appSecretReference,{kind:"exact",expectedReference:appSecretReference});
  const guard=async()=>{
   const current=await this.repository.metaManagedApprovalContext(body.tenantId as string,body.accountId as string,operator,requestId);
   if(JSON.stringify(current)!==JSON.stringify(binding))throw new ConflictException("Account approval changed.");
  };
  const metadata=await this.clients.create(token,binding.phoneNumberId,guard).verifyCredentialMetadata(appId,appSecret,"FINANCIAL");
  await guard();
  return this.repository.approveMetaSimulatedArrangement({...body,schemaVersion:1,appId,financialSecretReference:secretReference,
   financialCredentialFingerprint:createHash("sha256").update(token).digest("hex"),financialCredentialMetadata:metadata,
   graphVersion:process.env.META_GRAPH_VERSION??"",evidenceMode:"SIMULATED",admission:binding},operator,requestId);
 }
}
