import { BadRequestException, Body, ConflictException, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Req, SetMetadata, UseGuards } from "@nestjs/common";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { PlatformOperatorGuard, PlatformOperatorOnly, SkipTenantAuthentication } from "./platform-operator-auth.js";
import { PlatformOperationsRepository } from "./platform-operations.repository.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";
import { MetaDeletionService, metaDeletionRefusalPolicyUrl } from "./meta-deletion.service.js";
import { metaDeletionLocator, parseMetaDeletionForm, parseMetaDeletionReview, MetaDeletionContractError } from "./meta-deletion-contract.js";

@Controller("webhooks/meta/data-deletion")
@SetMetadata(PUBLIC_ROUTE, true)
export class MetaDeletionCallbackController {
  constructor(private readonly deletion: MetaDeletionService) {}
  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  receive(@Headers("content-type") contentType: string | undefined, @Body() body: unknown) {
    if (contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new BadRequestException("Deletion callback is invalid");
    return this.deletion.receive(parse(() => parseMetaDeletionForm(body)));
  }
  @Post("status")
  @HttpCode(200)
  @Header("Retry-After", "60")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  status(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("code" in body)) throw new BadRequestException("Status request is invalid");
    return this.deletion.status(parse(() => metaDeletionLocator((body as { code: unknown }).code)));
  }
}

@Controller("platform/v1/meta-deletion")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class MetaDeletionReviewController {
  constructor(private readonly operations: PlatformOperationsRepository) {}
  @Get()
  async list(@Req() request: PlatformOperatorRequest,@Query("cursor") cursor?:string) {
    if(cursor!==undefined&&!uuid(cursor))throw new BadRequestException("Deletion review cursor is invalid");
    return { ...await this.operations.metaDeletionReceipts(request.platformOperator, String(request.id),cursor), refusalAvailable:Boolean(metaDeletionRefusalPolicyUrl()) };
  }
  @Post(":receiptId/review")
  async review(@Req() request: PlatformOperatorRequest, @Param("receiptId") id: string, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    if (!uuid(id) || !key || !/^[A-Za-z0-9._:-]{8,128}$/u.test(key)) throw new BadRequestException("Review request is invalid");
    try { return await this.operations.reviewMetaDeletionReceipt({ id, key, ...parse(() => parseMetaDeletionReview(body)), operator: request.platformOperator, requestId: String(request.id), refusalPolicyUrl:metaDeletionRefusalPolicyUrl() }); }
    catch(error){if(error&&typeof error==="object"&&"code" in error&&["40001","23514","22023"].includes(String(error.code)))throw new ConflictException("Deletion review changed; reload before reviewing");throw error;}
  }
  @Post("lookup")
  @HttpCode(200)
  async lookup(@Req() request:PlatformOperatorRequest,@Body() body:unknown){
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||!("code" in body))throw new BadRequestException("Deletion lookup is invalid");
    return { ...await this.operations.metaDeletionReceipts(request.platformOperator,String(request.id),undefined,parse(()=>metaDeletionLocator(body.code))), refusalAvailable:Boolean(metaDeletionRefusalPolicyUrl()) };
  }
}
function parse<T>(callback: () => T): T { try { return callback(); } catch (error) { if (error instanceof MetaDeletionContractError) throw new BadRequestException("Deletion request is invalid"); throw error; } }
function uuid(value:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);}
