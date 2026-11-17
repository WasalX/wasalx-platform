import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { SignJWT } from "jose";
import { currentTraceCarrier } from "@wasalx/observability";
import { validatedRedisUrl } from "@wasalx/core/redis-security";

@Injectable()
export class TenantDrainService implements OnModuleDestroy{
  private readonly redis:Redis;private readonly deliveryQueue:Queue;private readonly inboundQueue:Queue;private readonly connectionQueue:Queue;private readonly privacyQueue:Queue;private readonly routingQueue:Queue;private readonly secret:Uint8Array;
  constructor(){const redisUrl=validatedRedisUrl(required("REDIS_URL"));this.secret=new TextEncoder().encode(required("WORKER_JOB_JWT_SECRET"));this.redis=new Redis(redisUrl,{maxRetriesPerRequest:null,enableReadyCheck:true});this.deliveryQueue=new Queue("wasalx-tenant-drain",{connection:this.redis});this.inboundQueue=new Queue("wasalx-inbound-drain",{connection:this.redis});this.connectionQueue=new Queue("wasalx-connection-drain",{connection:this.redis});this.privacyQueue=new Queue("wasalx-privacy-drain",{connection:this.redis});this.routingQueue=new Queue("wasalx-routing-drain",{connection:this.redis})}
  async wake(tenantId:string){return this.enqueue(this.deliveryQueue,tenantId,"delivery:drain","outbox-scheduler")}
  async wakeInbound(tenantId:string){return this.enqueue(this.inboundQueue,tenantId,"inbox:drain","inbox-scheduler")}
  async wakeConnection(tenantId:string){return this.enqueue(this.connectionQueue,tenantId,"connection:drain","connection-scheduler")}
  async wakePrivacy(tenantId:string){return this.enqueue(this.privacyQueue,tenantId,"privacy:drain","privacy-scheduler")}
  async wakeRouting(tenantId:string){return this.enqueue(this.routingQueue,tenantId,"routing:drain","routing-webhook")}
  async issueMediaUploadToken(tenantId:string,assetId:string){return new SignJWT({tenant_id:tenantId,instance_id:assetId,scope:"media:upload"}).setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("wasalx-control").setAudience("wasalx-connector-worker").setSubject("bot-media-upload").setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(this.secret)}
  async issueMetaCostSourceToken(tenantId:string,statementId:string,operation:"READ"|"UPLOAD"){
    return new SignJWT({tenant_id:tenantId,instance_id:statementId,scope:operation==="UPLOAD"?"meta-cost-source:upload":"meta-cost-source:read"})
      .setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("wasalx-control").setAudience("wasalx-connector-worker").setSubject("meta-cost-source")
      .setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(this.secret);
  }
  async ready(){try{return await this.redis.ping()==="PONG"}catch{return false}}
  private async enqueue(queue:Queue,tenantId:string,scope:string,subject:string){const token=await new SignJWT({tenant_id:tenantId,instance_id:"control-api",scope}).setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("wasalx-control").setAudience("wasalx-connector-worker").setSubject(subject).setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(this.secret);await queue.add("drain",{tenantId,token,telemetry:currentTraceCarrier()},{jobId:crypto.randomUUID(),removeOnComplete:1000,removeOnFail:5000,attempts:5,backoff:{type:"exponential",delay:1000}})}
  async onModuleDestroy(){await Promise.all([this.deliveryQueue.close(),this.inboundQueue.close(),this.connectionQueue.close(),this.privacyQueue.close(),this.routingQueue.close()]);this.redis.disconnect()}
}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value}
