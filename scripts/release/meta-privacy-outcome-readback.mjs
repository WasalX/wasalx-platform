// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Append these READ ONLY projections to the existing admitted guest; no new relay.
import assert from 'node:assert/strict';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
export function privacyOutcomeReadPlan({tenantId,requestId}) {
 assert(uuid(tenantId)&&uuid(requestId));
 return {values:[tenantId,requestId],text:`SELECT r.id AS "requestId",r.tenant_id AS "tenantId",r.request_type AS "requestType",r.scope_type AS "scopeType",
 r.state AS "requestState",r.error_code AS "requestError",r.completed_at AS "requestCompletedAt",j.id AS "jobId",j.state AS "jobState",j.stage,
 j.error_code AS "jobError",j.completed_at AS "jobCompletedAt",j.lease_id AS "leaseId",j.lease_expires_at AS "leaseExpiresAt",j.fencing_token AS "fencingToken",j.summary,
 a.id AS "artifactId",a.sha256 AS "artifactSha256",a.byte_size::text AS "artifactByteSize",a.expires_at AS "artifactExpiresAt",a.downloaded_at AS "downloadedAt",
 COALESCE((SELECT json_agg(x ORDER BY x.type,x.state) FROM (SELECT target_type AS type,state,count(*)::integer AS count FROM public.privacy_job_targets WHERE tenant_id=j.tenant_id AND job_id=j.id GROUP BY target_type,state) x),'[]'::json) AS targets,
 (SELECT count(*)::integer FROM public.privacy_object_cleanup c WHERE c.tenant_id=j.tenant_id AND c.job_id=j.id AND c.state='PENDING') AS "pendingObjectCleanup"
 FROM public.privacy_requests r JOIN public.privacy_jobs j ON j.tenant_id=r.tenant_id AND j.request_id=r.id
 LEFT JOIN public.privacy_export_artifacts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id WHERE r.tenant_id=$1 AND r.id=$2`};
}
export function localMetaOffboardingReadPlan({tenantId,connectionId,operationId}) {
 assert([tenantId,connectionId,operationId].every(uuid));
 return {values:[tenantId,connectionId,operationId],text:`SELECT c.id AS "connectionId",c.tenant_id AS "tenantId",c.provider,c.state AS "connectionState",o.id AS "operationId",o.operation_type AS "operationType",o.state AS "operationState",o.lease_id AS "operationLeaseId",o.lease_expires_at AS "operationLeaseExpiresAt",
 o.result->>'providerSubscriptionRetained' AS "subscriptionRetained",
 (SELECT count(*)::integer FROM public.provider_sessions s WHERE s.tenant_id=c.tenant_id AND s.connection_id=c.id AND s.ownership_state='ACTIVE') AS "activeSessions",
 (SELECT count(*)::integer FROM public.webhook_routes w WHERE w.tenant_id=c.tenant_id AND w.connection_id=c.id AND w.state<>'REVOKED') AS "unrevokedRoutes",
 COALESCE((SELECT json_agg(json_build_object('kind',x.cleanup_kind,'state',x.state) ORDER BY x.cleanup_kind,x.id) FROM public.secret_cleanup_outbox x WHERE x.tenant_id=c.tenant_id AND x.connection_id=c.id AND x.connection_operation_id=o.id),'[]'::json) AS cleanup
 FROM public.connections c JOIN public.connection_operations o ON o.tenant_id=c.tenant_id AND o.connection_id=c.id AND o.id=$3
 WHERE c.tenant_id=$1 AND c.id=$2 AND c.provider='META'`};
}

export function financialPrivacyReadPlan({tenantId,statementIds,requestId}) {
 assert(uuid(tenantId)&&uuid(requestId)&&Array.isArray(statementIds)&&statementIds.length>0&&statementIds.length<=200&&statementIds.every(uuid));
 return {values:[tenantId,statementIds,requestId],text:`SELECT s.id,s.version,s.evidence_mode AS "evidenceMode",s.lifecycle,s.source_state AS "sourceState",s.write_attempt_id AS "writeAttemptId",s.write_disposition AS "writeDisposition",s.write_settled_at AS "writeSettledAt",s.original_sha256 AS "originalSha256",s.original_byte_size AS "originalByteSize",s.scan_sha256 AS "scanSha256",s.source_purged_at AS "sourcePurgedAt",s.source_delete_after AS "sourceDeleteAfter",s.record_delete_after AS "recordDeleteAfter",s.input_sha256 AS "inputSha256",s.publication_sha256 AS "publicationSha256",
 COALESCE((SELECT json_agg(json_build_object('id',t.id,'type',t.target_type,'state',t.state,'attempts',t.attempts,'outcome',t.finance_review->>'outcome','bindingSha256',encode(sha256(convert_to(t.finance_binding::text,'UTF8')),'hex')) ORDER BY t.id)
 FROM public.privacy_job_targets t JOIN public.privacy_jobs j ON j.tenant_id=t.tenant_id AND j.id=t.job_id WHERE t.tenant_id=s.tenant_id AND j.request_id=$3 AND t.target_id=s.id::text AND t.target_type IN('FINANCE_SOURCE_REVIEW','META_COST_SOURCE','META_COST_RECORD')),'[]'::json) AS targets
 FROM public.meta_cost_statement_versions s WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY s.id`};
}
