import { registerWorkspaceBinary, WORKSPACE_UPLOAD_MAX_BYTES } from "./workspace-binary.js";
import { registerMetaDeletionForm } from "./meta-deletion-form.js";
import "reflect-metadata";
import type { RouteOptions } from "fastify";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { registerHttpObservability } from "./http-observability.js";
import { StructuredLogger } from "./structured-logger.js";
import { recordStructuredLog } from "@wasalx/observability";
import { META_WEBHOOK_MAX_BYTES } from "./webhook-security.js";

async function bootstrap(){const adapter=new FastifyAdapter({trustProxy:true,bodyLimit:META_WEBHOOK_MAX_BYTES});registerMetaDeletionForm(adapter);registerWorkspaceBinary(adapter);const app=await NestFactory.create<NestFastifyApplication>(AppModule,adapter,{logger:new StructuredLogger(),rawBody:true});app.getHttpAdapter().getInstance().addHook("onRoute",(route:RouteOptions)=>{if(route.url==="/v1/inbox/upload")route.bodyLimit=WORKSPACE_UPLOAD_MAX_BYTES;if(/^\/platform\/v1\/meta-costs\/tenants\/[^/]+\/statements(?:\/[^/]+(?:\/[^/]+)?)?$/u.test(route.url))route.bodyLimit=524_288;});registerHttpObservability(app);app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));app.enableShutdownHooks();app.enableCors({origin:(process.env.ALLOWED_ORIGINS??"").split(",").filter(Boolean),credentials:true,methods:["GET","POST","PUT","PATCH","DELETE"]});await app.listen({port:Number(process.env.PORT??3001),host:"0.0.0.0"});recordStructuredLog("info","control_api.ready",{port:Number(process.env.PORT??3001)})}
void bootstrap();
