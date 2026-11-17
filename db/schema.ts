import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const tenantColumns = { tenantId: text("tenant_id").notNull() };

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(), name: text("name").notNull(), slug: text("slug").notNull().unique(),
  plan: text("plan").notNull(), accent: text("accent").notNull(), createdAt: text("created_at").notNull(),
});

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(), ...tenantColumns, name: text("name").notNull(), phone: text("phone").notNull(),
  provider: text("provider").notNull(), engine: text("engine"), state: text("state").notNull(),
  groupCount: integer("group_count").notNull().default(0), lastEventAt: text("last_event_at"),
  actionReason: text("action_reason"), createdAt: text("created_at").notNull(),
});

export const whatsappGroups = sqliteTable("whatsapp_groups", {
  id: text("id").primaryKey(), ...tenantColumns, connectionId: text("connection_id").notNull(),
  name: text("name").notNull(), externalGroupId: text("external_group_id").notNull(),
  zammadGroup: text("zammad_group").notNull(), ruleName: text("rule_name").notNull(),
  enabled: integer("enabled",{mode:"boolean"}).notNull().default(true), members: integer("members").notNull().default(0),
  lastMessageAt: text("last_message_at"),
}, (table) => [uniqueIndex("groups_connection_external_uq").on(table.connectionId, table.externalGroupId)]);

export const triggerRules = sqliteTable("trigger_rules", {
  id: text("id").primaryKey(), ...tenantColumns, name: text("name").notNull(), matcherType: text("matcher_type").notNull(),
  pattern: text("pattern").notNull(), prefix: text("prefix"), digitLength: integer("digit_length"),
  priority: integer("priority").notNull(), enabled: integer("enabled",{mode:"boolean"}).notNull(),
  matchCount: integer("match_count").notNull().default(0), version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const eventInbox = sqliteTable("event_inbox", {
  id: text("id").primaryKey(), ...tenantColumns, connectionId: text("connection_id").notNull(),
  provider: text("provider").notNull(), providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(), payload: text("payload").notNull(), status: text("status").notNull(),
  receivedAt: text("received_at").notNull(),
}, (table) => [uniqueIndex("event_inbox_provider_event_uq").on(table.provider,table.connectionId,table.providerEventId)]);

export const caseCorrelations = sqliteTable("case_correlations", {
  id: text("id").primaryKey(), ...tenantColumns, groupBindingId: text("group_binding_id").notNull(),
  normalizedReference: text("normalized_reference").notNull(), zammadTicketId: text("zammad_ticket_id").notNull(),
  state: text("state").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("case_correlation_key_uq").on(table.tenantId,table.groupBindingId,table.normalizedReference)]);

export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(), ...tenantColumns, ticketNumber: text("ticket_number").notNull(),
  groupName: text("group_name").notNull(), excerpt: text("excerpt").notNull(), state: text("state").notNull(),
  provider: text("provider").notNull(), attempts: integer("attempts").notNull().default(0), errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), idempotencyKey: text("idempotency_key").notNull().unique(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), ...tenantColumns, actor: text("actor").notNull(), action: text("action").notNull(),
  target: text("target").notNull(), detail: text("detail").notNull(), requestId: text("request_id").notNull(),
  createdAt: text("created_at").notNull(),
});
