import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import { BotFlowsService } from "./bot-flows.service.js";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/bot-flows")
export class BotFlowsController {
  constructor(private readonly flows: BotFlowsService) {}

  @Get()
  @Requires("bot:read")
  list(@Req() request: AuthenticatedRequest) { return this.flows.list(request.principal); }

  @Get("ticket-events")
  @Requires("bot:read")
  ticketEvents(@Req() request:AuthenticatedRequest){return this.flows.ticketEventConfiguration(request.principal)}

  @Post("ticket-events")
  @Requires("bot:write")
  bindTicketEvent(@Req() request:AuthenticatedRequest,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.bindTicketEvent(request.principal,key,String(request.id),body);
  }

  @Get("catalog")
  @Requires("bot:read")
  flowCatalog(@Req() request:AuthenticatedRequest,@Query("cursor") cursor?:string,@Query("limit") limit?:string){return this.flows.flowCatalog(request.principal,{cursor,limit})}

  @Get("actions")
  @Requires("bot:read")
  listActions(@Req() request: AuthenticatedRequest) { return this.flows.listActions(request.principal); }

  @Get("actions/catalog")
  @Requires("bot:read")
  actionCatalog(@Req() request:AuthenticatedRequest,@Query("cursor") cursor?:string,@Query("limit") limit?:string){return this.flows.actionCatalog(request.principal,{cursor,limit})}

  @Get("assignments")
  @Requires("bot:read")
  listAssignments(@Req() request: AuthenticatedRequest) { return this.flows.listAssignments(request.principal); }

  @Get("media-assets")
  @Requires("bot:read")
  listMediaAssets(@Req() request:AuthenticatedRequest,@Query("id") ids?:string|string[]){return this.flows.listMediaAssets(request.principal,ids===undefined?[]:Array.isArray(ids)?ids:[ids])}

  @Post("media-assets")
  @Requires("bot:write")
  createMediaAsset(@Req() request:AuthenticatedRequest,@Headers("idempotency-key") key:string,@Body() body:unknown){return this.flows.createMediaAsset(request.principal,key,String(request.id),body)}

  @Get("conversations")
  @Requires("bot:read")
  listConversations(
    @Req() request: AuthenticatedRequest,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.flows.listConversations(request.principal, { cursor, limit });
  }

  @Get("conversations/:id/events")
  @Requires("bot:read")
  listConversationEvents(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.flows.listConversationEvents(request.principal, id, { cursor, limit });
  }

  @Get("routing")
  @Requires("bot:read")
  listRouting(@Req() request:AuthenticatedRequest){return this.flows.listRouting(request.principal)}

  @Get("routing/catalog")
  @Requires("bot:read")
  routingCatalog(@Req() request:AuthenticatedRequest,@Query("cursor") cursor?:string,@Query("limit") limit?:string){return this.flows.routingCatalog(request.principal,{cursor,limit})}

  @Get("routing/capabilities")
  @Requires("bot:read")
  routingCapabilities(){return this.flows.routingCapabilities()}

  @Get("routing/sources")
  @Requires("bot:read")
  listRoutingSources(@Req() request:AuthenticatedRequest){return this.flows.listRoutingSources(request.principal)}

  @Get("routing/integrations")
  @Requires("bot:read")
  listRoutingIntegrations(@Req() request:AuthenticatedRequest){return this.flows.listRoutingIntegrations(request.principal)}

  @Get("routing/:id")
  @Requires("bot:read")
  routingDetail(@Req() request:AuthenticatedRequest,@Param("id") id:string){return this.flows.routingDetail(request.principal,id)}

  @Post("routing/integrations/notion/start")
  @Requires("bot:write")
  startNotionRoutingOAuth(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.flows.startNotionRoutingOAuth(request.principal,String(request.id),body)}

  @Post("routing/integrations/notion/callback")
  @Requires("bot:write")
  completeNotionRoutingOAuth(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.flows.completeNotionRoutingOAuth(request.principal,String(request.id),body)}

  @Post("routing/integrations/notion/abort")
  @Requires("bot:write")
  abortNotionRoutingOAuth(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.flows.abortNotionRoutingOAuth(request.principal,String(request.id),body)}

  @Post("routing/integrations/credential")
  @Requires("bot:write")
  storeRoutingCredential(@Req() request:AuthenticatedRequest,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.storeRoutingCredential(request.principal,key,String(request.id),body);
  }

  @Post("routing/integrations/:id/test")
  @Requires("bot:write")
  testRoutingCredential(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.testRoutingCredential(request.principal,id,key,String(request.id),body);
  }

  @Get("routing/:versionId/qualifications")
  @Requires("bot:read")
  listRoutingQualifications(@Req() request:AuthenticatedRequest,@Param("versionId") versionId:string){return this.flows.listRoutingQualifications(request.principal,versionId)}

  @Post("routing/:versionId/sources/:sourceId/qualify")
  @Requires("bot:write")
  qualifyRoutingSource(@Req() request:AuthenticatedRequest,@Param("versionId") versionId:string,@Param("sourceId") sourceId:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.qualifyRoutingSource(request.principal,versionId,sourceId,key,String(request.id),body);
  }

  @Post("routing/sources/:id/sync")
  @Requires("bot:write")
  syncRoutingSource(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.syncRoutingSource(request.principal,id,key,String(request.id),body);
  }

  @Post("routing")
  @Requires("bot:write")
  createRouting(@Req() request:AuthenticatedRequest,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.createRouting(request.principal,key,String(request.id),body);
  }

  @Post("routing/simulate")
  @Requires("bot:read")
  simulateRouting(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.flows.simulateRouting(request.principal,body)}

  @Post("routing/:id/activate")
  @Requires("bot:write")
  activateRouting(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.activateRouting(request.principal,id,key,String(request.id),body);
  }

  @Post("actions")
  @Requires("bot:write")
  saveAction(@Req() request: AuthenticatedRequest, @Headers("idempotency-key") key:string, @Body() body: unknown) {
    return this.flows.saveAction(request.principal, key, String(request.id), body);
  }

  @Post("actions/credential")
  @Requires("bot:write")
  storeActionCredential(@Req() request: AuthenticatedRequest, @Headers("idempotency-key") key:string, @Body() body: unknown) {
    return this.flows.storeActionCredential(request.principal, key, String(request.id), body);
  }

  @Get("actions/:actionKey/revisions")
  @Requires("bot:read")
  listActionRevisions(@Req() request:AuthenticatedRequest,@Param("actionKey") actionKey:string){return this.flows.listActionRevisions(request.principal,actionKey)}

  @Get("actions/:actionKey")
  @Requires("bot:read")
  actionDetail(@Req() request:AuthenticatedRequest,@Param("actionKey") actionKey:string){return this.flows.actionDetail(request.principal,actionKey)}

  @Post("actions/:actionKey/revisions/:revision/restore")
  @Requires("bot:write")
  restoreActionRevision(@Req() request:AuthenticatedRequest,@Param("actionKey") actionKey:string,@Param("revision") revision:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.restoreActionRevision(request.principal,actionKey,revision,key,String(request.id),body);
  }

  @Post("actions/:actionKey/qualifications")
  @Requires("bot:write")
  qualifyAction(@Req() request:AuthenticatedRequest,@Param("actionKey") actionKey:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.qualifyAction(request.principal,actionKey,key,String(request.id),body);
  }

  @Get("actions/:actionKey/qualifications/:qualificationId")
  @Requires("bot:read")
  getActionQualification(@Req() request:AuthenticatedRequest,@Param("actionKey") actionKey:string,@Param("qualificationId") qualificationId:string){
    return this.flows.getActionQualification(request.principal,actionKey,qualificationId);
  }

  @Post()
  @Requires("bot:write")
  create(@Req() request: AuthenticatedRequest, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.create(request.principal, key, String(request.id), body);
  }

  @Get(":id")
  @Requires("bot:read")
  flowDetail(@Req() request:AuthenticatedRequest,@Param("id") id:string){return this.flows.flowDetail(request.principal,id)}

  @Post(":id/clone")
  @Requires("bot:write")
  clone(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.clone(request.principal, id, key, String(request.id), body);
  }

  @Post(":id/activate")
  @Requires("bot:write")
  activate(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.activate(request.principal, id, key, String(request.id), body);
  }

  @Post("assignments")
  @Requires("bot:write")
  assign(@Req() request: AuthenticatedRequest, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.assign(request.principal, key, String(request.id), body);
  }

  @Post("assignments/:id/state")
  @Requires("bot:write")
  setAssignmentState(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.setAssignmentState(request.principal, id, key, String(request.id), body);
  }

  @Post("assignments/:id/attribution")
  @Requires("bot:write")
  setAssignmentAttribution(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string, @Body() body: unknown) {
    return this.flows.setAssignmentAttribution(request.principal, id, key, String(request.id), body);
  }

  @Post("conversations/:id/command")
  @Requires("bot:operate")
  commandConversation(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Headers("idempotency-key") key:string,@Body() body:unknown){
    return this.flows.commandConversation(request.principal,id,key,String(request.id),body);
  }
}
