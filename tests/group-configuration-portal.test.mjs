import assert from "node:assert/strict";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import { readFile } from "node:fs/promises";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import ts from "typescript";

const app = await readTenantPortalSource();
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/groups/[id]/binding/route.ts", import.meta.url), "utf8");
const controller = await readFile(new URL("../services/control-api/src/groups.controller.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../services/control-api/migrations/0018_group_wasalx_name.sql", import.meta.url), "utf8");
const catalogRoute = await readFile(new URL("../app/api/zammad/routing-catalogs/route.ts", import.meta.url), "utf8");
const historySettingsRoute = await readFile(new URL("../app/api/group-workspace/settings/route.ts", import.meta.url), "utf8");
const historyGroupRoute = await readFile(new URL("../app/api/group-workspace/groups/[id]/route.ts", import.meta.url), "utf8");
const historyGrantRoute = await readFile(new URL("../app/api/group-workspace/groups/[id]/grants/route.ts", import.meta.url), "utf8");
const historyRevokeRoute = await readFile(new URL("../app/api/group-workspace/groups/[id]/grants/[grantId]/route.ts", import.meta.url), "utf8");
const workspaceAttributionMigration = await readFile(new URL("../services/control-api/migrations/0114_group_workspace_agent_attribution.sql", import.meta.url), "utf8");
const groupWorkspaceController = await readFile(new URL("../services/control-api/src/group-workspace.controller.ts", import.meta.url), "utf8");

test("group read model preserves unknown, empty, and populated member counts", async () => {
  const source=await readFile(new URL("../lib/control-plane-data.ts",import.meta.url),"utf8");
  const parsed=ts.createSourceFile("control-plane-data.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const declaration=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="normalizeGroup");
  assert.ok(declaration);
  const compiled=ts.transpileModule(declaration.getText(parsed),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const normalize=new Function(`${compiled};return normalizeGroup;`)();
  for(const [input,expected] of [[null,null],[0,0],[7,7],["7",7],[undefined,0]]){
    assert.equal(normalize({display_name:"Scoped group",participant_count:input}).members,expected);
  }
});

test("group configuration drawer exposes the complete v1 binding surface and recovery states", () => {
  for (const field of [
    "group-wasalx-name",
    "group-state",
    "group-zammad",
    "group-rule-set",
    "group-priority",
    "group-assignment",
    "group-fixed-owner",
    "group-sla",
    "group-acknowledgement",
    "group-agent-identity-placement",
    "group-agent-prefix",
    "group-max-identifiers",
    "group-retention",
    "group-media",
  ]) assert.match(app, new RegExp(field));
  for (const key of [
    "tenant.group.configureNamed",
    "tenant.group.viewNamed",
    "tenant.group.configure",
    "tenant.group.view",
    "tenant.group.configuration.readiness.blockedTitle",
    "tenant.group.configuration.readiness.blockedBody",
    "tenant.group.configuration.readiness.readyBody",
    "tenant.group.configuration.discard.title",
    "tenant.group.configuration.unavailable",
    "tenant.group.configuration.footer.saved",
    "tenant.group.configuration.messages.acknowledgementHelp",
    "tenant.group.configuration.messages.agentIdentityPlacement",
    "tenant.group.configuration.messages.preview",
  ]) assert.match(app, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(englishTenantMessages["tenant.group.configuration.discard.title"], /Discard unsaved changes/u);
  assert.match(englishTenantMessages["tenant.group.configuration.readiness.readyBody"], /Activating this group does not send a message/u);
  assert.match(englishTenantMessages["tenant.group.configuration.readiness.readyBody"], /next successful case acknowledgement/u);
  assert.doesNotMatch(englishTenantMessages["tenant.group.routing.unavailableSelection"], /\{value\}/u);
  assert.doesNotMatch(app, /unavailableSelection", \{ value \}/u);
  assert.match(app, /role="combobox"/);
  assert.match(app, /aria-autocomplete="list"/);
  for (const key of [
    "tenant.group.configuration.routing.unavailable",
    "tenant.group.configuration.routing.searchTeams",
    "tenant.group.configuration.routing.cannotCreateCases",
  ]) assert.match(app, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(app, /aria-labelledby="group-config-title"/);
  assert.match(app, /window\.addEventListener\("beforeunload"/);
  assert.match(styles, /\.group-drawer-backdrop/);
  assert.match(styles, /\.group-readiness\.has-blockers/);
  assert.match(styles, /\.group-agent-preview/);
  assert.match(styles, /\.routing-combobox-options/);
  assert.match(styles, /@media\(max-width:760px\).*\.group-drawer/s);
});

test("Zammad routing catalog BFF is tenant-authorized and never browser-cached", () => {
  assert.equal((catalogRoute.match(/authenticatePortalRequest\(request, "group:read"\)/g) ?? []).length, 1);
  assert.equal((catalogRoute.match(/authenticatePortalRequest\(request, "group:write"\)/g) ?? []).length, 0);
  assert.match(catalogRoute, /getZammadRoutingCatalog\(\)/);
  assert.match(catalogRoute, /private, no-store/);
});

test("group binding BFF remains tenant-authorized, no-store, and supports explicit fixture preview", () => {
  assert.match(route, /authenticatePortalRequest\(request, "group:read"\)/);
  assert.match(route, /authenticatePortalRequest\(request, "group:write"\)/);
  assert.match(route, /cache-control": "private, no-store"/);
  assert.match(route, /getGroupConfiguration/);
  assert.match(route, /saveGroupConfiguration/);
  assert.doesNotMatch(route, /requires the control-plane backend/i);
});

test("tenant alias cannot be overwritten by provider group synchronization", () => {
  assert.match(migration, /ADD COLUMN wasalx_name/);
  assert.match(controller, /COALESCE\(g\.wasalx_name, g\.display_name\) AS display_name/);
  assert.match(controller, /g\.display_name AS provider_display_name/);
  assert.match(controller, /SET wasalx_name = \$1/);
});

test("group history is fully configurable through tenant-authorized UI routes", () => {
  for(const field of ["group-history-capture","group-history-retention","group-history-visibility","group-history-agent-identity-placement","group-history-agent-prefix","group-history-subject-type","group-history-subject"])assert.match(app,new RegExp(field));
  assert.match(app,/const captureOnly=!detail\?\.binding_state/);
  assert.match(workspaceAttributionMigration,/group_workspace_settings[\s\S]*agent_prefix[\s\S]*agent_identity_placement/);
  assert.match(groupWorkspaceController,/workspace\.agent_prefix\) AS agent_prefix/);
  assert.match(groupWorkspaceController,/workspace\.agent_identity_placement\) AS agent_identity_placement/);
  assert.match(groupWorkspaceController,/\$9=0 OR EXISTS \([\s\S]*current\.tenant_id=g\.tenant_id[\s\S]*current\.whatsapp_group_id=g\.id[\s\S]*current\.version=\$9/);
  assert.match(app,/HistoryForm/);
  assert.match(app,/submit\(history\.version/);
  assert.match(app,/historyDirty\|\|historySaving/);
  assert.match(app,/loadHistory\(true\)/);
  assert.match(app,/aria-describedby="group-history-retention-help"/);
  assert.match(app,/aria-describedby="group-history-default-retention-help"/);
  assert.match(app,/tenant\.group\.history\.captureBody/);
  assert.match(app,/tenant\.settings\.sections\.\$\{item\}/);
  assert.match(styles,/\.group-history-grants/);
  assert.match(englishTenantMessages["tenant.group.history.captureBody"],/Earlier messages are never imported/u);
  assert.match(englishTenantMessages["tenant.group.history.access.help"],/Ticket access does not automatically grant/u);
  for(const routeSource of [historySettingsRoute,historyGroupRoute,historyGrantRoute,historyRevokeRoute])assert.match(routeSource,/private, no-store/);
  assert.match(historySettingsRoute,/settings:read/);assert.match(historySettingsRoute,/settings:write/);
  assert.match(historyGroupRoute,/group:read/);assert.match(historyGroupRoute,/group:write/);
  assert.match(historyGrantRoute,/group:write/);assert.match(historyRevokeRoute,/group:write/);
});

test("group history API preserves its numeric version contract for PostgreSQL bigint values",async()=>{
  const{GroupWorkspaceController}=await import("../services/control-api/dist/group-workspace.controller.js");
  const tenantId="10000000-0000-4000-8000-000000000001";
  const groupId="20000000-0000-4000-8000-000000000001";
  const request={principal:{tenantId}};
  const base={id:groupId,capture_enabled:false,enabled_at:null,retention_days:90,visibility:"RESTRICTED",
    agent_prefix:"Agent:",agent_identity_placement:"HEADER",group_workspace_enabled:false,grants:[]};
  const read=async version=>new GroupWorkspaceController({rows:async()=>[{...base,version}]}).group(request,groupId);
  const settings=async version=>new GroupWorkspaceController({rows:async()=>[{group_workspace_enabled:false,group_history_default_retention_days:90,group_history_default_visibility:"RESTRICTED",version}]}).settings(request);

  assert.equal((await read("0")).version,0);
  assert.equal((await settings("1")).version,1);
  assert.equal((await read(String(Number.MAX_SAFE_INTEGER))).version,Number.MAX_SAFE_INTEGER);
  for(const version of ["-1","1.5",String(Number.MAX_SAFE_INTEGER+1),null,undefined]){
    await assert.rejects(()=>read(version),error=>error?.getStatus?.()===500);
  }
  const controllerSource=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.equal((controllerSource.match(/return\{\.\.\.updated,version:apiVersion\(updated\.version\)\}/gu)??[]).length,2);
});

test("group history mutations use one durable tenant-scoped idempotency contract",async()=>{
  const controllerSource=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  const migrationSource=await readFile(new URL("../services/control-api/migrations/0110_group_workspace_operation_receipts.sql",import.meta.url),"utf8");
  for(const action of ["GROUP_WORKSPACE_DEFAULTS","GROUP_WORKSPACE_CAPTURE","GROUP_WORKSPACE_GRANT","GROUP_WORKSPACE_REVOKE"]){
    assert.match(controllerSource,new RegExp(`withOperationReceipt\\(client,request\\.principal,"${action}"`));
    assert.match(migrationSource,new RegExp(`'${action}'`));
  }
  assert.equal((controllerSource.match(/@Headers\("idempotency-key"\)/gu)??[]).length>=6,true);
  for(const routeSource of [historySettingsRoute,historyGroupRoute,historyGrantRoute,historyRevokeRoute]){
    assert.match(routeSource,/request\.headers\.get\("idempotency-key"\)/u);
    assert.match(routeSource,/status:400/u);
    assert.doesNotMatch(routeSource,/randomUUID/u);
  }
  assert.match(app,/historySaveKey\.current\?\?crypto\.randomUUID\(\)[\s\S]*"idempotency-key":idempotencyKey/u);
  assert.match(app,/response\.status===409[\s\S]*JSON\.stringify\(currentForm\)===JSON\.stringify\(savedHistoryForm\)[\s\S]*submit\(Number\(current\.version\),retryKey\)/u);
  assert.match(app,/grantOperationKeys\.current\.get\(operation\)\?\?crypto\.randomUUID\(\)/u);
  assert.match(app,/const saveKey=useRef<string\|null>\(null\)[\s\S]*saveKey\.current\?\?crypto\.randomUUID\(\)/u);

  const{withOperationReceipt}=await import("../services/control-api/dist/idempotent-operation.js");
  const receipts=new Map();let executions=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.startsWith("SELECT action,request_sha256,result")){
      const row=receipts.get(`${values[0]}:${values[1]}`);return{rows:row?[row]:[],rowCount:row?1:0};
    }
    if(sql.startsWith("INSERT INTO bot_flow_operations")){
      receipts.set(`${values[0]}:${values[2]}`,{action:values[1],request_sha256:values[3],result:values[4]});return{rows:[],rowCount:1};
    }
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const principal=tenantId=>({subject:`subject:${tenantId}`,userId:"10100000-0000-4000-8000-000000000001",tenantId,email:"owner@example.invalid",displayName:"Owner",role:"tenant_owner"});
  const operation=async()=>{executions+=1;return{version:2}};
  assert.deepEqual(await withOperationReceipt(client,principal("tenant-a"),"GROUP_WORKSPACE_DEFAULTS","defaults-1","a".repeat(64),"request-1",operation),{version:2,duplicate:false});
  assert.deepEqual(await withOperationReceipt(client,principal("tenant-a"),"GROUP_WORKSPACE_DEFAULTS","defaults-1","a".repeat(64),"request-2",operation),{version:2,duplicate:true});
  await assert.rejects(()=>withOperationReceipt(client,principal("tenant-a"),"GROUP_WORKSPACE_DEFAULTS","defaults-1","b".repeat(64),"request-3",operation),error=>error?.status===409);
  assert.deepEqual(await withOperationReceipt(client,principal("tenant-b"),"GROUP_WORKSPACE_DEFAULTS","defaults-1","a".repeat(64),"request-4",operation),{version:2,duplicate:false});
  assert.equal(executions,2);
});
