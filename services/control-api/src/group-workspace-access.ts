export function groupWorkspaceAccessSql(groupAlias:string,workspaceAlias:string,userParam:string,teamsParam:string,adminParam:string){return`(
  ${workspaceAlias}.visibility='ALL_AGENTS'
  OR EXISTS (SELECT 1 FROM group_workspace_grants access_grant WHERE access_grant.tenant_id=${groupAlias}.tenant_id
    AND access_grant.whatsapp_group_id=${groupAlias}.id AND access_grant.subject_type='USER'
    AND access_grant.subject_external_id=${userParam})
  OR EXISTS (SELECT 1 FROM group_workspace_grants access_grant WHERE access_grant.tenant_id=${groupAlias}.tenant_id
    AND access_grant.whatsapp_group_id=${groupAlias}.id AND access_grant.subject_type='TEAM'
    AND access_grant.subject_external_id=ANY(${teamsParam}::text[]))
  OR (${adminParam} AND NOT EXISTS (SELECT 1 FROM group_workspace_grants access_grant
    WHERE access_grant.tenant_id=${groupAlias}.tenant_id AND access_grant.whatsapp_group_id=${groupAlias}.id))
)`}

// Ticket replies use the ticket's pinned native queue; workspace grants govern
// the separate captured-history workspace, which need not be configured.
export function groupBindingReplyAccessSql(bindingAlias:string,ticketParam:string,teamsParam:string){return`EXISTS (
  SELECT 1 FROM case_correlations reply_case
  LEFT JOIN client_routing_versions reply_routing ON reply_routing.tenant_id=reply_case.tenant_id
    AND reply_routing.id=reply_case.client_routing_version_id
  WHERE reply_case.tenant_id=${bindingAlias}.tenant_id AND reply_case.group_binding_id=${bindingAlias}.id
    AND reply_case.zammad_ticket_id=${ticketParam} AND reply_case.state IN ('OPEN','RESOLVED')
    AND (CASE
      WHEN reply_case.client_routing_version_id IS NULL THEN ${bindingAlias}.zammad_group_id
      WHEN reply_case.client_route_status='FALLBACK' THEN reply_routing.definition->'fallback'->>'zammadGroupId'
      WHEN reply_case.client_route_status='MATCHED' THEN (
        SELECT client->>'zammadGroupId' FROM jsonb_array_elements(reply_routing.definition->'clients') client
        WHERE client->>'id'=reply_case.client_id
      )
    END)=ANY(${teamsParam}::text[])
)`}
