import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { supportsBotActionInvocation } from "@wasalx/core/bot-action-capabilities";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import {
  normalizeRuleTestMessage,
  RuleTestService,
  type RuleTestMatcherType,
} from "./rule-test.service.js";
import type { Principal } from "./types.js";

type SavedExample = {
  name: string;
  message: string;
  expectedMatches: string[];
  sender?: "team" | "customer" | "unknown";
};

type SnapshotRule = {
  id?: string;
  name: string;
  matcherType: RuleTestMatcherType;
  pattern: string;
  matcherOptions: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  savedExamples: SavedExample[];
};

type RuleSetRow = {
  id: string;
  tenant_id: string;
  family_id: string;
  name: string;
  version: number | string;
  state: "DRAFT" | "ACTIVE" | "RETIRED";
  revision: number | string;
  snapshot_sha256: string;
  supersedes_rule_set_id: string | null;
  rollback_source_rule_set_id: string | null;
  created_at: Date | string;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
};

type RuleRow = {
  id: string;
  name: string;
  matcher_type: RuleTestMatcherType;
  pattern: string;
  matcher_options: Record<string, unknown>;
  priority: number | string;
  enabled: boolean;
  saved_examples: unknown;
};

type OperationRow = {
  action: "CREATE" | "CLONE" | "ACTIVATE" | "ROLLBACK";
  request_sha256: string;
  result: Record<string, unknown>;
};

type ReadinessIssue = {
  code: string;
  message: string;
  ruleIds: string[];
  exampleName?: string;
};

type ExpectedActive = {
  ruleSetId: string | null;
  revision: number | null;
};

const MAXIMUM_RULES_PER_SET = 100;
const MAXIMUM_EXAMPLES_PER_RULE = 50;
const MAXIMUM_SAVED_EXAMPLE_BYTES = 50_000;

@Injectable()
export class RuleGovernanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tester: RuleTestService,
  ) {}

  list(principal: Principal,query:{before?:string;limit?:string;state?:string}={}) {
    const before=query.before===undefined?null:requireRuleSetUuid(query.before,"Rule-set cursor");
    const limit=ruleListLimit(query.limit);
    const state=query.state===undefined?null:ruleListState(query.state);
    return this.database.rows(
      principal.tenantId,
      `WITH cursor AS (
         SELECT family.name,version.version,version.id FROM rule_sets version JOIN rule_families family ON family.tenant_id=version.tenant_id AND family.id=version.family_id
          WHERE version.tenant_id=$1 AND version.id=$2
       ) SELECT s.id,s.family_id,f.name,s.version,s.state,s.revision,
              s.snapshot_sha256,s.supersedes_rule_set_id,
              s.rollback_source_rule_set_id,s.created_at,s.activated_at,s.retired_at,
              COALESCE(rule_data.rules,'[]'::jsonb) AS rules,
              COALESCE(metric_data.evaluated_message_count,0)::bigint AS evaluated_message_count,
              COALESCE(metric_data.matched_message_count,0)::bigint AS matched_message_count,
              COALESCE(metric_data.matched_reference_count,0)::bigint AS matched_reference_count,
              metric_data.last_evaluated_at
         FROM rule_sets s
         JOIN rule_families f ON f.tenant_id=s.tenant_id AND f.id=s.family_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id',r.id,'name',r.name,'matcherType',r.matcher_type,
             'pattern',r.pattern,'matcherOptions',r.matcher_options,
             'priority',r.priority,'enabled',r.enabled,
             'savedExamples',r.saved_examples
           ) ORDER BY r.priority,r.id) AS rules
             FROM trigger_rules r
            WHERE r.tenant_id=s.tenant_id AND r.rule_set_id=s.id
         ) rule_data ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT o.event_inbox_id) AS evaluated_message_count,
                  count(DISTINCT o.event_inbox_id) FILTER (
                    WHERE o.matched_reference_count>0
                  ) AS matched_message_count,
                  sum(o.matched_reference_count) AS matched_reference_count,
                  max(o.evaluated_at) AS last_evaluated_at
             FROM rule_match_observations o
            WHERE o.tenant_id=s.tenant_id AND o.rule_set_id=s.id
         ) metric_data ON true
        WHERE s.tenant_id=$1 AND ($3::text IS NULL OR s.state=$3)
          AND ($2::uuid IS NULL OR f.name>(SELECT name FROM cursor) OR (f.name=(SELECT name FROM cursor) AND s.version<(SELECT version FROM cursor)) OR (f.name=(SELECT name FROM cursor) AND s.version=(SELECT version FROM cursor) AND s.id>(SELECT id FROM cursor)))
        ORDER BY f.name,s.version DESC,s.id
        LIMIT $4`,
      [principal.tenantId,before,state,limit],
    );
  }

  async detail(principal: Principal, id: string) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      const snapshot = await readSnapshot(client, principal.tenantId, id);
      if (!snapshot) throw new NotFoundException("Rule-set version was not found");
      return presentSnapshot(snapshot);
    });
  }

  async readiness(principal: Principal, id: string) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      const snapshot = await readSnapshot(client, principal.tenantId, id);
      if (!snapshot) throw new NotFoundException("Rule-set version was not found");
      return this.evaluateReadiness(snapshot.rules);
    });
  }

  async metrics(principal: Principal, id: string, days: number) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      const exists = await client.query<{ id: string }>(
        "SELECT id FROM rule_sets WHERE tenant_id=$1 AND id=$2",
        [principal.tenantId, id],
      );
      if (!exists.rows[0]) throw new NotFoundException("Rule-set version was not found");
      const rows = (
        await client.query<{
          id: string;
          name: string;
          priority: number | string;
          evaluated_message_count: number | string;
          matched_message_count: number | string;
          matched_reference_count: number | string;
          first_evaluated_at: Date | string | null;
          last_evaluated_at: Date | string | null;
        }>(
          `SELECT r.id,r.name,r.priority,
                  count(o.event_inbox_id)::bigint AS evaluated_message_count,
                  count(o.event_inbox_id) FILTER (
                    WHERE o.matched_reference_count>0
                  )::bigint AS matched_message_count,
                  COALESCE(sum(o.matched_reference_count),0)::bigint AS matched_reference_count,
                  min(o.evaluated_at) AS first_evaluated_at,
                  max(o.evaluated_at) AS last_evaluated_at
             FROM trigger_rules r
             LEFT JOIN rule_match_observations o
               ON o.tenant_id=r.tenant_id
              AND o.trigger_rule_id=r.id
              AND o.evaluated_at>=now()-($3::integer*interval '1 day')
            WHERE r.tenant_id=$1 AND r.rule_set_id=$2
            GROUP BY r.id
            ORDER BY r.priority,r.id`,
          [principal.tenantId, id, days],
        )
      ).rows;
      return {
        ruleSetId: id,
        windowDays: days,
        generatedAt: new Date().toISOString(),
        hasObservations: rows.some((row) => Number(row.evaluated_message_count) > 0),
        rules: rows.map((row) => ({
          id: row.id,
          name: row.name,
          priority: Number(row.priority),
          evaluatedMessageCount: Number(row.evaluated_message_count),
          matchedMessageCount: Number(row.matched_message_count),
          matchedReferenceCount: Number(row.matched_reference_count),
          firstEvaluatedAt: isoOrNull(row.first_evaluated_at),
          lastEvaluatedAt: isoOrNull(row.last_evaluated_at),
        })),
      };
    });
  }

  async compare(principal: Principal, leftId: string, rightId: string) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      const [left, right] = await Promise.all([
        readSnapshot(client, principal.tenantId, leftId),
        readSnapshot(client, principal.tenantId, rightId),
      ]);
      if (!left || !right) throw new NotFoundException("A rule-set version was not found");
      if (left.set.family_id !== right.set.family_id) {
        throw new BadRequestException("Only versions in the same rule family can be compared");
      }
      return compareSnapshots(left, right);
    });
  }

  async create(
    principal: Principal,
    idempotencyKey: string,
    requestId: string,
    body: unknown,
  ) {
    const input = this.normalizeCreate(body);
    const requestSha256 = hashJson({ action: "CREATE", input });
    return this.database.withTenant(principal.tenantId, async (client) =>
      this.withOperation(
        client,
        principal,
        "CREATE",
        idempotencyKey,
        requestSha256,
        requestId,
        async () => {
          await familyLock(client, principal.tenantId, input.name);
          const existing = await client.query<{ id: string }>(
            "SELECT id FROM rule_families WHERE tenant_id=$1 AND name=$2",
            [principal.tenantId, input.name],
          );
          if (existing.rows[0]) {
            throw new ConflictException("Rule family already exists; clone a version instead");
          }
          const family = (
            await client.query<{ id: string }>(
              "SELECT app.create_rule_family($1,$2) AS id",
              [input.name, principal.userId],
            )
          ).rows[0];
          if (!family) throw new Error("Rule family could not be persisted");
          const created = await insertSnapshot(client, principal, {
            familyId: family.id,
            name: input.name,
            version: 1,
            rules: input.rules,
          });
          const result = presentCreated(created);
          await appendAudit(client, principal, {
            action: "rule_set.created",
            targetType: "rule_set",
            targetId: created.id,
            requestId,
            newValue: result,
          });
          return { resultId: created.id, result };
        },
      ),
    );
  }

  async clone(
    principal: Principal,
    sourceId: string,
    idempotencyKey: string,
    requestId: string,
    body: unknown,
  ) {
    const override = this.normalizeClone(body);
    const requestSha256 = hashJson({ action: "CLONE", sourceId, override });
    return this.database.withTenant(principal.tenantId, async (client) =>
      this.withOperation(
        client,
        principal,
        "CLONE",
        idempotencyKey,
        requestSha256,
        requestId,
        async () => {
          const candidate = await readSnapshot(client, principal.tenantId, sourceId);
          if (!candidate) throw new NotFoundException("Source rule-set version was not found");
          await familyLock(client, principal.tenantId, candidate.set.family_id);
          const source = await readSnapshot(client, principal.tenantId, sourceId, true);
          if (!source) throw new NotFoundException("Source rule-set version was not found");
          const version = await nextVersion(client, principal.tenantId, source.set.family_id);
          const rules = override.rules ?? stripRuleIds(source.rules);
          const created = await insertSnapshot(client, principal, {
            familyId: source.set.family_id,
            name: source.set.name,
            version,
            rules,
            supersedesRuleSetId: source.set.id,
          });
          const result = presentCreated(created);
          await appendAudit(client, principal, {
            action: "rule_set.cloned",
            targetType: "rule_set",
            targetId: created.id,
            requestId,
            previousValue: {
              source_rule_set_id: source.set.id,
              source_version: Number(source.set.version),
            },
            newValue: result,
          });
          return { sourceId: source.set.id, resultId: created.id, result };
        },
      ),
    );
  }

  async activate(
    principal: Principal,
    targetId: string,
    idempotencyKey: string,
    requestId: string,
    body: unknown,
  ) {
    const input = normalizeActivation(body);
    const requestSha256 = hashJson({ action: "ACTIVATE", targetId, input });
    return this.database.withTenant(principal.tenantId, async (client) =>
      this.withOperation(
        client,
        principal,
        "ACTIVATE",
        idempotencyKey,
        requestSha256,
        requestId,
        async () => {
          const candidate = await readSnapshot(client, principal.tenantId, targetId);
          if (!candidate) {
            throw new ConflictException("The requested draft is no longer available for activation");
          }
          await familyLock(client, principal.tenantId, candidate.set.family_id);
          const target = await readSnapshot(client, principal.tenantId, targetId, true);
          if (!target || target.set.state !== "DRAFT") {
            throw new ConflictException("The requested draft is no longer available for activation");
          }
          if (Number(target.set.revision) !== input.expectedRevision) {
            throw new ConflictException("Rule-set version changed; refresh before activation");
          }
          const readiness = this.evaluateReadiness(target.rules);
          if (!readiness.ready) {
            throw new UnprocessableEntityException({
              message: "Rule-set version is not ready for activation",
              readiness,
            });
          }
          await validateGroupCommandActions(client,principal.tenantId,target.set.id,target.rules,target.set.supersedes_rule_set_id??undefined);
          const transition = await activateSnapshot(
            client,
            principal,
            target,
            input.expectedActive,
            requestId,
          );
          const result = {
            ...presentCreated(transition.active),
            retiredRuleSetId: transition.retired?.id ?? null,
            bindingsMigrated: transition.bindingsMigrated,
            readiness,
          };
          await appendAudit(client, principal, {
            action: "rule_set.activated",
            targetType: "rule_set",
            targetId: targetId,
            requestId,
            previousValue: transition.retired
              ? {
                  active_rule_set_id: transition.retired.id,
                  version: Number(transition.retired.version),
                  revision: Number(transition.retired.revision),
                }
              : { active_rule_set_id: null },
            newValue: result,
          });
          return { sourceId: transition.retired?.id, resultId: targetId, result };
        },
      ),
    );
  }

  async rollback(
    principal: Principal,
    sourceId: string,
    idempotencyKey: string,
    requestId: string,
    body: unknown,
  ) {
    const input = normalizeRollback(body);
    const requestSha256 = hashJson({ action: "ROLLBACK", sourceId, input });
    return this.database.withTenant(principal.tenantId, async (client) =>
      this.withOperation(
        client,
        principal,
        "ROLLBACK",
        idempotencyKey,
        requestSha256,
        requestId,
        async () => {
          const candidate = await readSnapshot(client, principal.tenantId, sourceId);
          if (!candidate) throw new NotFoundException("Rollback source version was not found");
          await familyLock(client, principal.tenantId, candidate.set.family_id);
          const source = await readSnapshot(client, principal.tenantId, sourceId, true);
          if (!source) throw new NotFoundException("Rollback source version was not found");
          if (source.set.state !== "RETIRED") {
            throw new ConflictException("Only a retired version can be used as a rollback source");
          }
          if (Number(source.set.revision) !== input.expectedSourceRevision) {
            throw new ConflictException("Rollback source changed; refresh before rollback");
          }
          const active = await selectActive(client, principal.tenantId, source.set.family_id, true);
          assertExpectedActive(active, input.expectedActive);
          if (!active) throw new ConflictException("There is no active version to roll back");
          const version = await nextVersion(client, principal.tenantId, source.set.family_id);
          const created = await insertSnapshot(client, principal, {
            familyId: source.set.family_id,
            name: source.set.name,
            version,
            rules: stripRuleIds(source.rules),
            supersedesRuleSetId: active.id,
            rollbackSourceRuleSetId: source.set.id,
          });
          const draft = await readSnapshot(client, principal.tenantId, created.id, true);
          if (!draft) throw new Error("Rollback snapshot could not be reloaded");
          const readiness = this.evaluateReadiness(draft.rules);
          if (!readiness.ready) {
            throw new UnprocessableEntityException({
              message: "Historical rule content no longer passes activation safety checks",
              readiness,
            });
          }
          await validateGroupCommandActions(client,principal.tenantId,draft.set.id,draft.rules,source.set.id);
          const transition = await activateSnapshot(
            client,
            principal,
            draft,
            input.expectedActive,
            requestId,
            active,
          );
          const result = {
            ...presentCreated(transition.active),
            rollbackSourceRuleSetId: source.set.id,
            rollbackSourceVersion: Number(source.set.version),
            retiredRuleSetId: active.id,
            bindingsMigrated: transition.bindingsMigrated,
            readiness,
          };
          await appendAudit(client, principal, {
            action: "rule_set.rolled_back",
            targetType: "rule_set",
            targetId: created.id,
            requestId,
            previousValue: {
              active_rule_set_id: active.id,
              active_version: Number(active.version),
              rollback_source_rule_set_id: source.set.id,
              rollback_source_version: Number(source.set.version),
            },
            newValue: result,
          });
          return { sourceId: source.set.id, resultId: created.id, result };
        },
      ),
    );
  }

  private normalizeCreate(value: unknown) {
    const record = requireRecord(value, "Rule-set request is required");
    assertKnownFields(record, new Set(["name", "rules"]), "Rule-set request");
    const name = requiredText(record.name, "Rule-set name", 160);
    return { name, rules: this.normalizeRules(record.rules) };
  }

  private normalizeClone(value: unknown) {
    const record = value === undefined || value === null ? {} : requireRecord(value, "Clone request is invalid");
    assertKnownFields(record, new Set(["rules"]), "Clone request");
    return { rules: record.rules === undefined ? undefined : this.normalizeRules(record.rules) };
  }

  private normalizeRules(value: unknown): SnapshotRule[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_RULES_PER_SET) {
      throw new BadRequestException(`A rule set must contain between 1 and ${MAXIMUM_RULES_PER_SET} rules`);
    }
    const priorities = new Set<number>();
    const names = new Set<string>();
    return value
      .map((candidate, index) => {
        const record = requireRecord(candidate, `Rule ${index + 1} is invalid`);
        assertKnownFields(
          record,
          new Set(["name", "matcherType", "pattern", "matcherOptions", "priority", "enabled", "savedExamples"]),
          `Rule ${index + 1}`,
        );
        const name = requiredText(record.name, `Rule ${index + 1} name`, 160);
        const normalizedName = name.toLocaleLowerCase("en-US");
        if (names.has(normalizedName)) throw new BadRequestException("Rule names must be unique within a version");
        names.add(normalizedName);
        const matcherType = String(record.matcherType ?? "") as RuleTestMatcherType;
        if (!new Set(["exact_length", "prefix_length", "starts_with", "contains", "advanced"]).has(matcherType)) {
          throw new BadRequestException(`Rule ${index + 1} has an unsupported matcher type`);
        }
        const pattern = requiredText(record.pattern, `Rule ${index + 1} pattern`, 240);
        const matcherOptions = record.matcherOptions === undefined
          ? {}
          : requireRecord(record.matcherOptions, `Rule ${index + 1} matcher options are invalid`);
        assertKnownFields(
          matcherOptions,
          new Set(["prefix", "digitLength", "groupCommand", "teamSenderPolicy"]),
          `Rule ${index + 1} matcher options`,
        );
        const groupCommand=matcherOptions.groupCommand===undefined?undefined:normalizeGroupCommand(matcherOptions.groupCommand,index,matcherType,pattern);
        const priority = Number(record.priority);
        if (!Number.isSafeInteger(priority) || priority < 1 || priority > 10_000 || priorities.has(priority)) {
          throw new BadRequestException("Rule priorities must be unique integers between 1 and 10000");
        }
        priorities.add(priority);
        if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
          throw new BadRequestException(`Rule ${index + 1} enabled must be a boolean`);
        }
        const savedExamples = normalizeSavedExamples(record.savedExamples, index);
        const rule: SnapshotRule = {
          name,
          matcherType,
          pattern,
          matcherOptions:{...matcherOptions,...(groupCommand?{groupCommand}:{})},
          priority,
          enabled: record.enabled ?? true,
          savedExamples,
        };
        // The same bounded Node/RE2 implementation used by /v1/rules/test is
        // the authoritative compile check for persisted rules.
        this.tester.evaluate({
          message: savedExamples[0]?.message ?? "WasalX validation sample",
          sender: savedExamples[0]?.sender,
          rules: [testerRule(rule, `rule-${index + 1}`)],
        });
        return rule;
      })
      .sort((left, right) => left.priority - right.priority);
  }

  private evaluateReadiness(rules: SnapshotRule[]) {
    const blockers: ReadinessIssue[] = [];
    const warnings: ReadinessIssue[] = [];
    const enabled = rules.filter((rule) => rule.enabled);
    if (enabled.length === 0) {
      blockers.push({
        code: "NO_ENABLED_RULES",
        message: "At least one rule must be enabled before activation.",
        ruleIds: [],
      });
    }
    const signatures = new Map<string, SnapshotRule>();
    for (const rule of enabled) {
      const signature = hashJson({
        matcherType: rule.matcherType,
        pattern: rule.pattern,
        matcherOptions: rule.matcherOptions,
      });
      const duplicate = signatures.get(signature);
      if (duplicate) {
        blockers.push({
          code: "DUPLICATE_MATCHER",
          message: `${duplicate.name} and ${rule.name} have identical matcher semantics.`,
          ruleIds: [duplicate.id!, rule.id!],
        });
      } else {
        signatures.set(signature, rule);
      }
      if (rule.savedExamples.length === 0) {
        warnings.push({
          code: "NO_SAVED_EXAMPLES",
          message: `${rule.name} has no saved examples; add positive and negative cases for safer changes.`,
          ruleIds: [rule.id!],
        });
      }
    }

    let checkedExamples = 0;
    for (const owner of enabled) {
      for (const example of owner.savedExamples) {
        checkedExamples += 1;
        let outcome: ReturnType<RuleTestService["evaluate"]>;
        try {
          outcome = this.tester.evaluate({
            message: example.message,
            sender: example.sender,
            rules: rules.map((rule, index) => testerRule(rule, rule.id ?? `rule-${index + 1}`)),
          });
        } catch (error) {
          blockers.push({
            code: "INVALID_SAVED_EXAMPLE",
            message: `${owner.name} example ${example.name} could not be evaluated: ${safeErrorMessage(error)}`,
            ruleIds: [owner.id!],
            exampleName: example.name,
          });
          continue;
        }
        const actual = uniqueSorted(
          outcome.matches
            .filter((match) => match.ruleId === owner.id)
            .map((match) => match.normalizedValue),
        );
        if (JSON.stringify(actual) !== JSON.stringify(example.expectedMatches)) {
          blockers.push({
            code: "SAVED_EXAMPLE_MISMATCH",
            message: `${owner.name} example ${example.name} no longer produces its saved expected references.`,
            ruleIds: [owner.id!],
            exampleName: example.name,
          });
        }
        for (const warning of outcome.warnings) {
          const issue: ReadinessIssue = {
            code: warning.code,
            message: warning.message,
            ruleIds: warning.ruleIds,
            exampleName: example.name,
          };
          if (warning.code === "OVERLAPPING_RULES" || warning.code === "MATCH_LIMIT_REACHED") {
            blockers.push(issue);
          } else {
            warnings.push(issue);
          }
        }
      }
    }
    return {
      ready: blockers.length === 0,
      enabledRuleCount: enabled.length,
      checkedExamples,
      blockers: deduplicateIssues(blockers),
      warnings: deduplicateIssues(warnings),
    };
  }

  private async withOperation(
    client: PoolClient,
    principal: Principal,
    action: OperationRow["action"],
    idempotencyKey: string,
    requestSha256: string,
    requestId: string,
    operation: () => Promise<{
      sourceId?: string;
      resultId: string;
      result: Record<string, unknown>;
    }>,
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`rule-operation:${principal.tenantId}:${idempotencyKey}`],
    );
    const replay = (
      await client.query<OperationRow>(
        `SELECT action,request_sha256,result
           FROM rule_set_operations
          WHERE tenant_id=$1 AND idempotency_key=$2`,
        [principal.tenantId, idempotencyKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.action !== action || replay.request_sha256 !== requestSha256) {
        throw new ConflictException("Idempotency key was already used for a different rule operation");
      }
      return { ...replay.result, duplicate: true };
    }
    const outcome = await operation();
    await client.query(
      `INSERT INTO rule_set_operations (
         tenant_id,action,idempotency_key,request_sha256,source_rule_set_id,
         result_rule_set_id,result,requested_by,request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        principal.tenantId,
        action,
        idempotencyKey,
        requestSha256,
        outcome.sourceId ?? null,
        outcome.resultId,
        outcome.result,
        principal.userId,
        requestId,
      ],
    );
    return { ...outcome.result, duplicate: false };
  }
}

async function readSnapshot(
  client: PoolClient,
  tenantId: string,
  id: string,
  lock = false,
) {
  const set = (
    await client.query<RuleSetRow>(
      `SELECT s.id,s.tenant_id,s.family_id,f.name,s.version,s.state,s.revision,
              s.snapshot_sha256,s.supersedes_rule_set_id,
              s.rollback_source_rule_set_id,s.created_at,s.activated_at,s.retired_at
         FROM rule_sets s
         JOIN rule_families f ON f.tenant_id=s.tenant_id AND f.id=s.family_id
        WHERE s.tenant_id=$1 AND s.id=$2${lock ? " FOR UPDATE OF s" : ""}`,
      [tenantId, id],
    )
  ).rows[0];
  if (!set) return null;
  const rows = (
    await client.query<RuleRow>(
      `SELECT id,name,matcher_type,pattern,matcher_options,priority,enabled,saved_examples
         FROM trigger_rules
        WHERE tenant_id=$1 AND rule_set_id=$2
        ORDER BY priority,id`,
      [tenantId, id],
    )
  ).rows;
  return { set, rules: rows.map(fromRuleRow) };
}

async function insertSnapshot(
  client: PoolClient,
  principal: Principal,
  input: {
    familyId: string;
    name: string;
    version: number;
    rules: SnapshotRule[];
    supersedesRuleSetId?: string;
    rollbackSourceRuleSetId?: string;
  },
) {
  const set = (
    await client.query<{
      id: string;
      family_id: string;
      version: number | string;
      state: "DRAFT";
      revision: number | string;
      snapshot_sha256: string;
    }>(
      `SELECT id,family_id,version,state,revision,snapshot_sha256
         FROM app.create_rule_set_snapshot($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        input.familyId,
        input.name,
        input.version,
        input.supersedesRuleSetId ?? null,
        input.rollbackSourceRuleSetId ?? null,
        principal.userId,
        JSON.stringify(stripRuleIds(input.rules)),
      ],
    )
  ).rows[0];
  if (!set) throw new Error("Rule-set snapshot could not be persisted");
  return {
    id: set.id,
    familyId: set.family_id,
    name: input.name,
    version: Number(set.version),
    state: set.state,
    revision: Number(set.revision),
    snapshotSha256: set.snapshot_sha256,
    supersedesRuleSetId: input.supersedesRuleSetId ?? null,
    rollbackSourceRuleSetId: input.rollbackSourceRuleSetId ?? null,
  };
}

async function activateSnapshot(
  client: PoolClient,
  principal: Principal,
  target: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>,
  expectedActive: ExpectedActive,
  requestId: string,
  selectedActive?: RuleSetRow,
) {
  const active = selectedActive ?? await selectActive(
    client,
    principal.tenantId,
    target.set.family_id,
    true,
  );
  assertExpectedActive(active, expectedActive);
  let retired: RuleSetRow | null = null;
  if (active) {
    retired = (
      await client.query<RuleSetRow>(
        `UPDATE rule_sets
            SET state='RETIRED',revision=revision+1,
                retired_at=now(),retired_by=$1
          WHERE tenant_id=$2 AND id=$3 AND state='ACTIVE' AND revision=$4
        RETURNING id,tenant_id,family_id,name,version,state,revision,
                  snapshot_sha256,supersedes_rule_set_id,
                  rollback_source_rule_set_id,created_at,activated_at,retired_at`,
        [principal.userId, principal.tenantId, active.id, Number(active.revision)],
      )
    ).rows[0] ?? null;
    if (!retired) throw new ConflictException("Active rule-set changed during activation");
  }
  if(active)await client.query(
    `SELECT group_record.id FROM whatsapp_groups group_record
      JOIN group_bindings binding ON binding.tenant_id=group_record.tenant_id AND binding.whatsapp_group_id=group_record.id
     WHERE binding.tenant_id=$1 AND binding.rule_set_id=$2
     ORDER BY group_record.id FOR UPDATE OF group_record`,
    [principal.tenantId,active.id],
  );
  const bindingUpdate = active
    ? await client.query<{id:string;revision:string|number}>(
        `UPDATE group_bindings
            SET rule_set_id=$1,revision=revision+1,updated_at=now()
          WHERE tenant_id=$2 AND rule_set_id=$3
      RETURNING id,revision`,
        [target.set.id, principal.tenantId, active.id],
      )
    : { rows:[] as Array<{id:string;revision:string|number}>,rowCount: 0 };
  for(const binding of bindingUpdate.rows){
    await client.query("SELECT app.record_group_binding_version($1,$2,$3,$4)",[
      binding.id,Number(binding.revision),principal.userId,requestId,
    ]);
  }
  const activated = (
    await client.query<{
      id: string;
      family_id: string;
      version: number | string;
      state: "ACTIVE";
      revision: number | string;
      snapshot_sha256: string;
    }>(
      `UPDATE rule_sets
          SET state='ACTIVE',revision=revision+1,
              activated_at=now(),activated_by=$1
        WHERE tenant_id=$2 AND id=$3 AND state='DRAFT' AND revision=$4
      RETURNING id,family_id,version,state,revision,snapshot_sha256`,
      [principal.userId, principal.tenantId, target.set.id, Number(target.set.revision)],
    )
  ).rows[0];
  if (!activated) throw new ConflictException("Draft changed during activation");
  return {
    active: {
      id: activated.id,
      familyId: activated.family_id,
      name: target.set.name,
      version: Number(activated.version),
      state: activated.state,
      revision: Number(activated.revision),
      snapshotSha256: activated.snapshot_sha256,
      supersedesRuleSetId: target.set.supersedes_rule_set_id,
      rollbackSourceRuleSetId: target.set.rollback_source_rule_set_id,
    },
    retired,
    bindingsMigrated: bindingUpdate.rowCount ?? 0,
  };
}

async function selectActive(
  client: PoolClient,
  tenantId: string,
  familyId: string,
  lock: boolean,
) {
  return (
    await client.query<RuleSetRow>(
      `SELECT id,tenant_id,family_id,name,version,state,revision,snapshot_sha256,
              supersedes_rule_set_id,rollback_source_rule_set_id,
              created_at,activated_at,retired_at
         FROM rule_sets
        WHERE tenant_id=$1 AND family_id=$2 AND state='ACTIVE'${lock ? " FOR UPDATE" : ""}`,
      [tenantId, familyId],
    )
  ).rows[0] ?? null;
}

function assertExpectedActive(active: RuleSetRow | null, expected: ExpectedActive) {
  if ((active?.id ?? null) !== expected.ruleSetId) {
    throw new ConflictException("Active rule-set changed; refresh before continuing");
  }
  if (active && Number(active.revision) !== expected.revision) {
    throw new ConflictException("Active rule-set revision changed; refresh before continuing");
  }
}

async function familyLock(client: PoolClient, tenantId: string, familyKey: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`rule-family:${tenantId}:${familyKey}`],
  );
}

async function nextVersion(client: PoolClient, tenantId: string, familyId: string) {
  const value = (
    await client.query<{ version: number | string }>(
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM rule_sets WHERE tenant_id=$1 AND family_id=$2",
      [tenantId, familyId],
    )
  ).rows[0]?.version;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Next rule-set version is invalid");
  return version;
}

function normalizeActivation(value: unknown) {
  const record = requireRecord(value, "Activation request is required");
  assertKnownFields(
    record,
    new Set(["expectedRevision", "expectedActiveRuleSetId", "expectedActiveRevision"]),
    "Activation request",
  );
  return {
    expectedRevision: positiveInteger(record.expectedRevision, "expectedRevision"),
    expectedActive: normalizeExpectedActive(record),
  };
}

function normalizeRollback(value: unknown) {
  const record = requireRecord(value, "Rollback request is required");
  assertKnownFields(
    record,
    new Set(["expectedSourceRevision", "expectedActiveRuleSetId", "expectedActiveRevision"]),
    "Rollback request",
  );
  return {
    expectedSourceRevision: positiveInteger(record.expectedSourceRevision, "expectedSourceRevision"),
    expectedActive: normalizeExpectedActive(record),
  };
}

function normalizeExpectedActive(record: Record<string, unknown>): ExpectedActive {
  if (!("expectedActiveRuleSetId" in record)) {
    throw new BadRequestException("expectedActiveRuleSetId is required and may be null");
  }
  if (record.expectedActiveRuleSetId === null) {
    if (record.expectedActiveRevision !== null && record.expectedActiveRevision !== undefined) {
      throw new BadRequestException("expectedActiveRevision must be null when no active version is expected");
    }
    return { ruleSetId: null, revision: null };
  }
  return {
    ruleSetId: requireRuleSetUuid(record.expectedActiveRuleSetId, "expectedActiveRuleSetId"),
    revision: positiveInteger(record.expectedActiveRevision, "expectedActiveRevision"),
  };
}

function normalizeGroupCommand(value:unknown,index:number,matcherType:RuleTestMatcherType,pattern:string){
  if(matcherType!=="starts_with"||!pattern.startsWith("/"))throw new BadRequestException(`Rule ${index+1} group commands must use a slash-prefixed starts-with matcher`);
  const command=requireRecord(value,`Rule ${index+1} group command is invalid`);
  assertKnownFields(command,new Set(["actionId","input","successReply","failureReply"]),`Rule ${index+1} group command`);
  const actionId=requiredText(command.actionId,"Group command action",128);
  if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(actionId))throw new BadRequestException("Group command action key is invalid");
  const input=requireRecord(command.input??{},"Group command input is invalid");
  if(Object.keys(input).length>25)throw new BadRequestException("Group command input has too many fields");
  const normalizedInput=Object.fromEntries(Object.entries(input).map(([key,item])=>{
    if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key))throw new BadRequestException("Group command input key is invalid");
    return[key,requiredText(item,`Group command input ${key}`,500)];
  }));
  return{actionId,input:normalizedInput,successReply:requiredText(command.successReply,"Group command success reply",1000),failureReply:requiredText(command.failureReply,"Group command failure reply",1000)};
}

async function validateGroupCommandActions(client:PoolClient,tenantId:string,ruleSetId:string,rules:SnapshotRule[],sourceRuleSetId?:string){
  const commands=rules.flatMap(rule=>rule.enabled&&isRecord(rule.matcherOptions.groupCommand)?[{rule,command:rule.matcherOptions.groupCommand}]:[]);
  const actionIds=[...new Set(commands.map(({command})=>String(command.actionId??"")))];
  if(sourceRuleSetId&&actionIds.length)await client.query(`INSERT INTO automation_action_revision_pins
      (tenant_id,rule_set_id,action_definition_id,action_revision_id)
    SELECT pin.tenant_id,$1,pin.action_definition_id,pin.action_revision_id
    FROM automation_action_revision_pins pin
    JOIN bot_action_definitions action
      ON action.tenant_id=pin.tenant_id AND action.id=pin.action_definition_id
    WHERE pin.tenant_id=$2 AND pin.rule_set_id=$3 AND action.action_key=ANY($4::text[])
    ON CONFLICT DO NOTHING`,[ruleSetId,tenantId,sourceRuleSetId,actionIds]);
  type PinnedAction={id:string;action_key:string;active_revision_id:string;response_mapping:Record<string,string>;kind:string;endpoint_url:string;http_method:string;auth_scheme:string;secret_reference:string|null};
  const readPinned=()=>client.query<PinnedAction>(`SELECT action.id,action.action_key,revision.id AS active_revision_id,
      revision.response_mapping,revision.kind,revision.endpoint_url,revision.http_method,revision.auth_scheme,revision.secret_reference
    FROM automation_action_revision_pins pin
    JOIN bot_action_definitions action
      ON action.tenant_id=pin.tenant_id AND action.id=pin.action_definition_id
    JOIN bot_action_revisions revision
      ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
    WHERE pin.tenant_id=$1 AND pin.rule_set_id=$2 AND action.action_key=ANY($3::text[])
      AND revision.state='ACTIVE'`,[tenantId,ruleSetId,actionIds]);
  let pinned=actionIds.length?(await readPinned()).rows:[];
  const missingActionIds=actionIds.filter(actionId=>!pinned.some(action=>action.action_key===actionId));
  if(missingActionIds.length){
    const available=(await client.query<PinnedAction>(`SELECT id,action_key,active_revision_id,response_mapping,kind,endpoint_url,http_method,auth_scheme,secret_reference
      FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=ANY($2::text[]) AND state='ACTIVE' FOR SHARE`,[tenantId,missingActionIds])).rows;
    for(const action of available)await client.query(`INSERT INTO automation_action_revision_pins
      (tenant_id,rule_set_id,action_definition_id,action_revision_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[tenantId,ruleSetId,action.id,action.active_revision_id]);
    pinned=(await readPinned()).rows;
  }
  for(const {rule,command} of commands){
    const actionId=String(command.actionId??"");
    const action=pinned.find(candidate=>candidate.action_key===actionId);
    if(!action||!supportsBotActionInvocation({kind:action.kind,endpointUrl:action.endpoint_url,httpMethod:action.http_method,authScheme:action.auth_scheme,secretReference:action.secret_reference},"GROUP_COMMAND"))throw new BadRequestException(`Group command action ${actionId} is unavailable for group commands`);
    const base=new Set([
      "channel.kind","channel.provider","channel.connection_id","message.id","message.text","message.argument",
      "group.id","group.name","customer.zammad_id","customer.login","customer.name","match.value","ticket.id","ticket.number",
    ]);
    validateCommandTemplates(rule,Object.values(isRecord(command.input)?command.input:{}),base);
    validateCommandTemplates(rule,[command.successReply],new Set([...base,...Object.keys(action.response_mapping??{})]));
    validateCommandTemplates(rule,[command.failureReply],new Set([...base,"action.error"]));
  }
}

function validateCommandTemplates(rule:SnapshotRule,templates:unknown[],available:Set<string>){for(const template of templates)for(const match of String(template??"").matchAll(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/giu))if(!available.has(match[1]!))throw new BadRequestException(`${rule.name} uses unavailable group command variable ${match[1]}`)}

function normalizeSavedExamples(value: unknown, ruleIndex: number): SavedExample[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_EXAMPLES_PER_RULE) {
    throw new BadRequestException(
      `Rule ${ruleIndex + 1} can contain at most ${MAXIMUM_EXAMPLES_PER_RULE} saved examples`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAXIMUM_SAVED_EXAMPLE_BYTES) {
    throw new BadRequestException(`Rule ${ruleIndex + 1} saved examples exceed the allowed size`);
  }
  const names = new Set<string>();
  return value.map((candidate, exampleIndex) => {
    const record = requireRecord(candidate, `Rule ${ruleIndex + 1} saved example ${exampleIndex + 1} is invalid`);
    assertKnownFields(record, new Set(["name", "message", "expectedMatches", "sender"]), "Saved example");
    const sender = record.sender;
    if (sender !== undefined && sender !== "team" && sender !== "customer" && sender !== "unknown") {
      throw new BadRequestException("Saved example sender must be team, customer or unknown");
    }
    const name = requiredText(
      record.name ?? `Example ${exampleIndex + 1}`,
      `Rule ${ruleIndex + 1} example name`,
      120,
    );
    const key = name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new BadRequestException("Saved example names must be unique within a rule");
    names.add(key);
    const message = requiredText(record.message, `Rule ${ruleIndex + 1} example message`, 10_000);
    if (Buffer.byteLength(message, "utf8") > 40_000) {
      throw new BadRequestException(`Rule ${ruleIndex + 1} example message is too large`);
    }
    if (!Array.isArray(record.expectedMatches) || record.expectedMatches.length > 100) {
      throw new BadRequestException("Saved example expectedMatches must be an array of at most 100 references");
    }
    const expectedMatches = uniqueSorted(record.expectedMatches.map((match) => {
      const normalized = normalizeRuleTestMessage(requiredText(match, "Expected reference", 256)).toUpperCase();
      if (!normalized) throw new BadRequestException("Expected references must not normalize to an empty value");
      return normalized;
    }));
    return { name, message, expectedMatches, ...(sender === undefined ? {} : { sender }) };
  });
}

function fromRuleRow(row: RuleRow): SnapshotRule {
  return {
    id: row.id,
    name: row.name,
    matcherType: row.matcher_type,
    pattern: row.pattern,
    matcherOptions: row.matcher_options ?? {},
    priority: Number(row.priority),
    enabled: row.enabled,
    savedExamples: Array.isArray(row.saved_examples)
      ? row.saved_examples.map((value, index) => savedExampleFromDatabase(value, index))
      : [],
  };
}

function savedExampleFromDatabase(value: unknown, index: number): SavedExample {
  if (!isRecord(value)) {
    return { name: `Invalid example ${index + 1}`, message: " ", expectedMatches: [] };
  }
  return {
    name: typeof value.name === "string" ? value.name : `Example ${index + 1}`,
    message: typeof value.message === "string" ? value.message : " ",
    ...(value.sender === undefined ? {} : {
      sender: value.sender === "team" || value.sender === "customer" ? value.sender : "unknown" as const,
    }),
    expectedMatches: Array.isArray(value.expectedMatches)
      ? value.expectedMatches.filter((item): item is string => typeof item === "string").sort()
      : [],
  };
}

function testerRule(rule: SnapshotRule, id: string) {
  return {
    id,
    name: rule.name,
    matcherType: rule.matcherType,
    pattern: rule.pattern,
    matcherOptions: rule.matcherOptions,
    prefix: typeof rule.matcherOptions.prefix === "string" ? rule.matcherOptions.prefix : undefined,
    digitLength: typeof rule.matcherOptions.digitLength === "number"
      ? rule.matcherOptions.digitLength
      : undefined,
    priority: rule.priority,
    enabled: rule.enabled,
  };
}

function stripRuleIds(rules: SnapshotRule[]) {
  return rules.map((rule) => ({
    name: rule.name,
    matcherType: rule.matcherType,
    pattern: rule.pattern,
    matcherOptions: rule.matcherOptions,
    priority: rule.priority,
    enabled: rule.enabled,
    savedExamples: rule.savedExamples.map((item) => ({ ...item })),
  }));
}

function snapshotHash(rules: SnapshotRule[]) {
  return hashJson(stripRuleIds([...rules].sort((left, right) => left.priority - right.priority)));
}

function compareSnapshots(
  left: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>,
  right: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>,
) {
  const leftRules = new Map(left.rules.map((rule) => [rule.name.toLocaleLowerCase("en-US"), rule]));
  const rightRules = new Map(right.rules.map((rule) => [rule.name.toLocaleLowerCase("en-US"), rule]));
  const names = [...new Set([...leftRules.keys(), ...rightRules.keys()])].sort();
  const changes = names.map((name) => {
    const before = leftRules.get(name);
    const after = rightRules.get(name);
    if (!before) return { kind: "ADDED", name: after!.name, before: null, after: presentRule(after!) };
    if (!after) return { kind: "REMOVED", name: before.name, before: presentRule(before), after: null };
    return {
      kind: snapshotHash([before]) === snapshotHash([after]) ? "UNCHANGED" : "CHANGED",
      name: after.name,
      before: presentRule(before),
      after: presentRule(after),
    };
  });
  return {
    familyId: left.set.family_id,
    left: presentSnapshotIdentity(left.set),
    right: presentSnapshotIdentity(right.set),
    summary: {
      added: changes.filter((change) => change.kind === "ADDED").length,
      removed: changes.filter((change) => change.kind === "REMOVED").length,
      changed: changes.filter((change) => change.kind === "CHANGED").length,
      unchanged: changes.filter((change) => change.kind === "UNCHANGED").length,
    },
    changes,
  };
}

function presentSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>) {
  return { ...presentSnapshotIdentity(snapshot.set), rules: snapshot.rules.map(presentRule) };
}

function presentSnapshotIdentity(set: RuleSetRow) {
  return {
    id: set.id,
    familyId: set.family_id,
    name: set.name,
    version: Number(set.version),
    state: set.state,
    revision: Number(set.revision),
    snapshotSha256: set.snapshot_sha256,
    supersedesRuleSetId: set.supersedes_rule_set_id,
    rollbackSourceRuleSetId: set.rollback_source_rule_set_id,
    createdAt: isoOrNull(set.created_at),
    activatedAt: isoOrNull(set.activated_at),
    retiredAt: isoOrNull(set.retired_at),
  };
}

function presentCreated(value: {
  id: string;
  familyId: string;
  name: string;
  version: number;
  state: string;
  revision: number;
  snapshotSha256: string;
  supersedesRuleSetId: string | null;
  rollbackSourceRuleSetId: string | null;
}) {
  return value;
}

function presentRule(rule: SnapshotRule) {
  return {
    id: rule.id,
    name: rule.name,
    matcherType: rule.matcherType,
    pattern: rule.pattern,
    matcherOptions: rule.matcherOptions,
    priority: rule.priority,
    enabled: rule.enabled,
    savedExamples: rule.savedExamples,
  };
}

function hashJson(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BadRequestException(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertKnownFields(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BadRequestException(`${label} contains unsupported fields`);
  }
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new BadRequestException(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasUnsafeControl(normalized)) {
    throw new BadRequestException(`${label} must contain between 1 and ${maximum} safe characters`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new BadRequestException(`${label} must be a positive integer`);
  }
  return number;
}

export function requireRuleIdempotencyKey(value: string | undefined) {
  if (
    !value ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}\s]/u.test(value)
  ) {
    throw new BadRequestException("A valid Idempotency-Key header is required");
  }
  return value;
}

export function requireRuleSetUuid(value: unknown, label = "Rule-set ID") {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new BadRequestException(`${label} must be a UUID`);
  }
  return value;
}

export function ruleMetricDays(value: unknown) {
  if (value === undefined) return 30;
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new BadRequestException("Metric window must be between 1 and 365 days");
  }
  return days;
}

function ruleListLimit(value:unknown){
  if(value===undefined)return 200;
  if(typeof value!=="string"||!/^[1-9][0-9]{0,2}$/u.test(value)||Number(value)>200)
    throw new BadRequestException("Rule-set limit is invalid");
  return Number(value);
}

function ruleListState(value:unknown){
  if(value!=="DRAFT"&&value!=="ACTIVE"&&value!=="RETIRED")
    throw new BadRequestException("Rule-set state is invalid");
  return value;
}

function hasUnsafeControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deduplicateIssues(issues: ReadinessIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.ruleIds.join(",")}:${issue.exampleName ?? ""}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isoOrNull(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "Invalid saved example";
}
