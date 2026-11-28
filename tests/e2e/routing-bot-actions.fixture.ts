import { expect, test, type Page, type Request } from "@playwright/test";
import { formatNumber } from "../../lib/i18n/format";
import { arabicMessages } from "../../lib/i18n/messages/ar/index.ts";
import { englishMessages } from "../../lib/i18n/messages/en/index.ts";
import { createTranslator } from "../../lib/i18n/translate";

const createdAt = "2026-11-28T08:00:00.000Z";
const directory = {
  id: "directory",
  name: "Service directory",
  kind: "HTTP_JSON",
  syncMode: "SCHEDULED",
  scheduleMinutes: 15,
  endpointUrl: "https://directory.example.test/clients",
  secretReference: "secret://configured/directory",
  fieldMapping: {},
};
const runningDirectory = {
  ...directory,
  id: "running-directory",
  name: "Running directory",
  secretReference: "secret://configured/running-directory",
};
const failedDirectory = {
  ...directory,
  id: "failed-directory",
  name: "Failed directory",
  secretReference: "secret://configured/failed-directory",
};
const integration = {
  id: "87000000-0000-4000-8000-000000000061",
  provider: directory.kind,
  display_name: directory.name,
  auth_scheme: "BEARER",
  binding_reference: directory.secretReference,
  state: "CONNECTED",
  revision: 7,
};
const routing = {
  id: "86000000-0000-4000-8000-000000000061",
  version: 1,
  revision: 2,
  state: "ACTIVE",
  created_at: createdAt,
  definition: {
    schemaVersion: 1,
    name: "Directory routing",
    fallback: { zammadGroupId: "2" },
    sources: [directory, runningDirectory, failedDirectory],
    clients: [],
  },
};
const draft = {
  ...routing,
  id: "86000000-0000-4000-8000-000000000062",
  version: 2,
  revision: 4,
  state: "DRAFT",
  definition: { ...routing.definition, sources: [directory] },
};
const sourceStatus = {
  source_id: directory.id,
  state: "ACTIVE",
  snapshot_revision: 8,
  latest_job_state: "SUCCEEDED",
  latest_job_attempts: 1,
};
const failedStatus = {
  ...sourceStatus,
  source_id: failedDirectory.id,
  latest_job_state: "FAILED_TERMINAL",
};
const action = {
  id: "83000000-0000-4000-8000-000000000061",
  action_key: "directory.lookup",
  name: "Directory lookup",
  revision: 3,
  kind: "HTTP_JSON",
  http_method: "GET",
  endpoint_url: "https://directory.example.test/clients",
  state: "ACTIVE",
};
const previousAction = {
  ...action,
  id: `${action.id}:2`,
  name: "Previous directory lookup",
  revision: 2,
  active: false,
};
const assignment = {
  id: "84000000-0000-4000-8000-000000000061",
  connection_id: "12000000-0000-4000-8000-000000000001",
  connection_name: "Directory support line",
  connection_state: "WORKING",
  provider: "WAHA",
  flow_name: "Directory support workflow",
  version: 1,
  zammad_group_id: "2",
  state: "ACTIVE",
  revision: 9,
  agent_prefix: "Agent:",
  agent_identity_placement: "HEADER",
};
const syncPath = `/api/client-routing/sources/${directory.id}/sync`;
const draftPath = `/api/client-routing/${draft.id}`;
const qualifyPath = `${draftPath}/sources/${directory.id}/qualify`;
const qualificationsPath = `${draftPath}/qualifications`;
const actionPath = `/api/bot-flows/actions/${action.action_key}`;
const historyPath = `${actionPath}/revisions`;
const restorePath = `${historyPath}/${previousAction.revision}/restore`;
const assignmentsPath = "/api/bot-flows/assignments";
const attributionPath = `${assignmentsPath}/${assignment.id}/attribution`;
const pluginCatalog = "**/api/bot-flows/actions/catalog?limit=50";

export function registerRoutingBotActionJourneys(
  locale: "en" | "ar",
  role: string,
  open: (page: Page, view: string) => Promise<void>,
  expectNetworkFailure: (
    page: Page,
    path: string,
    status: number | string,
  ) => void,
) {
  if (role !== "tenant_owner" && role !== "auditor") return;
  const t = createTranslator(
    locale === "ar" ? arabicMessages : englishMessages,
  );
  const draftLabel = t("routing.versions.version", {
    version: formatNumber(draft.version, locale),
  });
  const sourceCard = (page: Page, name: string) =>
    page
      .locator(".routing-source-list")
      .getByRole("listitem")
      .filter({ has: page.getByText(name, { exact: true }) });

  test.describe("Routing and workflow actions", () => {
    test.beforeEach(async ({ page }) => {
      await page.route("**/api/client-routing/catalog?limit=25", (route) =>
        route.fulfill({ json: { items: [routing, draft], next_cursor: null } }),
      );
      await page.route("**/api/client-routing/sources", (route) =>
        route.fulfill({ json: [sourceStatus, failedStatus] }),
      );
      await page.route("**/api/client-routing/integrations", (route) =>
        route.fulfill({ json: [integration] }),
      );
      await page.route(`**${qualificationsPath}`, (route) =>
        route.fulfill({ json: [] }),
      );
      await page.route(pluginCatalog, (route) =>
        route.fulfill({ json: { items: [action], next_cursor: null } }),
      );
      await page.route(`**${assignmentsPath}`, (route) =>
        route.fulfill({ json: [assignment] }),
      );
    });

    if (role === "auditor") {
      test("auditor cannot sync, qualify, restore or edit attribution", async ({
        page,
      }) => {
        await open(page, "routing");
        const card = sourceCard(page, directory.name);
        await expect(
          card.getByText(
            t("routing.sources.revision", {
              revision: formatNumber(sourceStatus.snapshot_revision, locale),
            }),
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          card.getByRole("button", { name: t("routing.sources.syncNow") }),
        ).toHaveCount(0);
        const failed = sourceCard(page, failedDirectory.name);
        await expect(failed).toContainText(
          t("automation.status.failedTerminal"),
        );
        await expect(
          failed.getByRole("button", { name: t("routing.sources.retry") }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: draftLabel }).click();
        await expect(
          card.getByText(t("routing.sources.qualification"), { exact: true }),
        ).toBeVisible();
        await expect(
          card.getByRole("button", { name: t("routing.sources.qualify") }),
        ).toHaveCount(0);

        await open(page, "plugins");
        const plugin = page
          .getByRole("article")
          .filter({ hasText: action.name });
        await expect(plugin).toBeVisible();
        // Version history is inside the configure dialog.
        await expect(
          plugin.getByRole("button", { name: t("plugins.actions.configure") }),
        ).toHaveCount(0);

        await open(page, "automation");
        await page
          .getByRole("tab", { name: t("bot.tabs.assignments") })
          .click();
        const row = page.getByRole("article").filter({
          hasText: assignment.connection_name,
        });
        await expect(row).toBeVisible();
        await expect(
          row.getByRole("button", {
            name: t("bot.assignments.attribution.configure"),
          }),
        ).toHaveCount(0);
      });
      return;
    }

    test("source sync retries once and refreshes after a conflict", async ({
      page,
    }) => {
      const requests: Request[] = [];
      const refreshedRevision = sourceStatus.snapshot_revision + 1;
      await page.route("**/api/client-routing/sources", (route) =>
        route.fulfill({
          json: [
            {
              ...sourceStatus,
              state: requests.length === 2 ? "CONFLICT" : "ACTIVE",
              snapshot_revision:
                requests.length >= 2
                  ? refreshedRevision
                  : sourceStatus.snapshot_revision,
              latest_job_state: requests.length === 3 ? "QUEUED" : "SUCCEEDED",
            },
            {
              ...sourceStatus,
              source_id: runningDirectory.id,
              latest_job_state: "RUNNING",
            },
            failedStatus,
          ],
        }),
      );
      await page.route(`**${syncPath}`, (route) => {
        requests.push(route.request());
        if (requests.length === 1) {
          return route.fulfill({ status: 503, json: {} });
        }
        if (requests.length === 2) {
          return route.fulfill({ status: 409, json: { code: "CONFLICT" } });
        }
        return route.fulfill({
          status: 202,
          json: { sourceId: directory.id, snapshotRevision: refreshedRevision },
        });
      });
      await open(page, "routing");
      const card = sourceCard(page, directory.name);
      const syncNow = t("routing.sources.syncNow");
      const retry = t("routing.sources.retry");
      const sync = card.getByRole("button", { name: syncNow, exact: true });
      const notice = page
        .getByRole("status")
        .getByText(t("routing.notice.syncRequested"), { exact: true });
      await expect(
        sourceCard(page, runningDirectory.name).getByRole("button", {
          name: syncNow,
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        sourceCard(page, failedDirectory.name).getByRole("button", {
          name: retry,
          exact: true,
        }),
      ).toBeEnabled();
      expectNetworkFailure(page, syncPath, 503);
      await sync.click();
      await expect(
        page.getByRole("alert").getByText(t("common.errors.unavailable")),
      ).toBeVisible();
      await expect(notice).toHaveCount(0);
      expectNetworkFailure(page, syncPath, 409);
      await sync.click();
      const alert = page.getByRole("alert").filter({
        hasText: t("common.errors.conflict"),
      });
      await expect(alert).toBeVisible();
      await expect(notice).toHaveCount(0);
      await alert
        .getByRole("button", { name: t("automation.common.reload") })
        .click();
      await card.getByRole("button", { name: retry, exact: true }).click();
      await expect(notice).toBeVisible();
      await expect(card).toContainText(t("automation.status.queued"));
      await expect(sync).toBeDisabled();
      expect(requests).toHaveLength(3);
      const key = requests[0].headers()["idempotency-key"];
      expect(key).toBeTruthy();
      for (const request of requests.slice(0, 2)) {
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toEqual({
          expectedSnapshotRevision: sourceStatus.snapshot_revision,
        });
        expect(request.headers()["idempotency-key"]).toBe(key);
      }
      expect(requests[2].method()).toBe("POST");
      expect(requests[2].postDataJSON()).toEqual({
        expectedSnapshotRevision: refreshedRevision,
      });
      const newKey = requests[2].headers()["idempotency-key"];
      expect(newKey).toBeTruthy();
      expect(newKey).not.toBe(key);
    });

    test("safe check reports failure and reloads the qualification", async ({
      page,
    }) => {
      const requests: Request[] = [];
      await page.route(`**${qualificationsPath}`, (route) =>
        route.fulfill({
          json:
            requests.length < 2
              ? []
              : [
                  {
                    routing_version_id: draft.id,
                    source_id: directory.id,
                    state: "QUEUED",
                  },
                ],
        }),
      );
      await page.route(`**${qualifyPath}`, (route) => {
        requests.push(route.request());
        if (requests.length === 1) {
          return route.fulfill({ status: 503, json: {} });
        }
        return route.fulfill({
          status: 202,
          json: { routingVersionId: draft.id, sourceId: directory.id },
        });
      });
      await open(page, "routing");
      await page.getByRole("button", { name: draftLabel }).click();
      const card = sourceCard(page, directory.name);
      const run = card.getByRole("button", {
        name: t("routing.sources.qualify"),
      });
      const requested = t("routing.notice.qualificationRequested", {
        source: directory.name,
      });
      const notice = page.getByRole("status").getByText(requested, {
        exact: true,
      });
      const notRun = card.getByText(t("routing.sources.qualificationNotRun"), {
        exact: true,
      });
      await expect(notRun).toBeVisible();
      expectNetworkFailure(page, qualifyPath, 503);
      await run.click();
      await expect(
        page.getByRole("alert").getByText(t("common.errors.unavailable")),
      ).toBeVisible();
      await expect(notice).toHaveCount(0);
      await expect(notRun).toBeVisible();
      await run.click();
      await expect(notice).toBeVisible();
      await expect(
        card.getByText(
          t("routing.sources.qualificationState", {
            state: t("automation.status.queued"),
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(run).toBeDisabled();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toEqual({
          integrationId: integration.id,
          expectedIntegrationRevision: integration.revision,
          expectedRoutingRevision: draft.revision,
        });
      }
    });

    test("plugin restore confirms and retries after response loss", async ({
      page,
    }) => {
      const writes: Request[] = [];
      page.on("request", (request) => {
        if (
          request.method() !== "GET" &&
          new URL(request.url()).pathname.startsWith("/api/bot-flows/actions")
        ) {
          writes.push(request);
        }
      });
      await page.route(`**${actionPath}`, (route) =>
        route.fulfill({ json: action }),
      );
      await page.route(`**${historyPath}`, (route) =>
        route.fulfill({
          json: [
            { ...action, id: `${action.id}:3`, active: true },
            previousAction,
          ],
        }),
      );
      const restored = {
        ...action,
        name: previousAction.name,
        revision: action.revision + 1,
      };
      let current = action;
      await page.route(pluginCatalog, (route) =>
        route.fulfill({ json: { items: [current], next_cursor: null } }),
      );
      await page.route(`**${restorePath}`, (route) => {
        if (current === action) {
          current = restored;
          return route.abort("failed");
        }
        return route.fulfill({
          json: {
            actionKey: action.action_key,
            revision: restored.revision,
            duplicate: true,
          },
        });
      });
      await open(page, "plugins");
      await page
        .getByRole("button", { name: t("plugins.actions.configure") })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: t("plugins.history.title") }),
      ).toBeVisible();
      const restore = dialog
        .getByRole("listitem")
        .filter({ hasText: previousAction.name })
        .getByRole("button", {
          name: t("plugins.history.restore"),
          exact: true,
        });
      const confirmation = page.getByRole("alertdialog", {
        name: t("plugins.history.confirmTitle", {
          revision: previousAction.revision,
        }),
      });
      const confirm = confirmation.getByRole("button", {
        name: t("plugins.history.confirm"),
      });
      await restore.click();
      await expect(confirmation).toBeVisible();
      expect(writes).toHaveLength(0);
      await confirmation
        .getByRole("button", {
          name: t("automation.common.cancel"),
          exact: true,
        })
        .click();
      await expect(confirmation).toHaveCount(0);
      expect(writes).toHaveLength(0);

      await restore.click();
      expectNetworkFailure(page, restorePath, "net::ERR_FAILED");
      await confirm.click();
      const notice = page.getByText(
        t("plugins.history.restored", { revision: previousAction.revision }),
        { exact: true },
      );
      await expect(
        dialog.getByText(t("common.errors.network"), { exact: true }),
      ).toBeVisible();
      await expect(notice).toHaveCount(0);
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(notice).toBeVisible();
      await expect(
        page.getByRole("article").getByText(restored.name, { exact: true }),
      ).toBeVisible();
      expect(writes).toHaveLength(2);
      const key = writes[0].headers()["idempotency-key"];
      expect(key).toBeTruthy();
      for (const request of writes) {
        expect(new URL(request.url()).pathname).toBe(restorePath);
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toEqual({
          expectedRevision: action.revision,
        });
        expect(request.headers()["idempotency-key"]).toBe(key);
      }
    });

    test("attribution previews placement and keeps edits on conflict", async ({
      page,
    }) => {
      const requests: Request[] = [];
      await page.route(`**${attributionPath}`, (route) => {
        requests.push(route.request());
        return route.fulfill({ status: 409, json: { code: "CONFLICT" } });
      });
      await open(page, "automation");
      await page.getByRole("tab", { name: t("bot.tabs.assignments") }).click();
      await page
        .getByRole("button", {
          name: t("bot.assignments.attribution.configure"),
        })
        .click();
      const dialog = page.getByRole("dialog", {
        name: t("bot.assignments.attribution.title", {
          name: assignment.connection_name,
        }),
      });
      const prefix = dialog.getByRole("textbox", {
        name: t("bot.assignments.attribution.prefix"),
      });
      const placement = dialog.getByRole("combobox", {
        name: t("bot.assignments.attribution.placement"),
      });
      const save = dialog.getByRole("button", {
        name: t("bot.assignments.attribution.save"),
      });
      const preview = dialog.locator(".bot-attribution-preview bdi");
      const example = t("bot.assignments.attribution.messageExample");
      const label = locale === "ar" ? "الدعم:" : "Support:";
      const agent = `${label} ${t("bot.assignments.attribution.agentExample")}`;
      await prefix.fill("   ");
      await expect(save).toBeDisabled();
      await prefix.fill(` ${label} `);
      await expect(preview).toHaveText(`${agent}\n${example}`);
      if (locale === "ar") await expect(preview).toHaveCSS("direction", "rtl");
      await placement.selectOption("FOOTER");
      await expect(preview).toHaveText(`${example}\n${agent}`);
      await placement.selectOption("OFF");
      await expect(preview).toHaveText(
        t("bot.assignments.attribution.previewOff"),
      );
      await placement.selectOption("FOOTER");
      expectNetworkFailure(page, attributionPath, 409);
      await save.click();
      await expect(dialog.getByRole("alert")).toHaveText(
        t("common.errors.conflict"),
      );
      await expect(prefix).toHaveValue(` ${label} `);
      await expect(placement).toHaveValue("FOOTER");
      await expect(
        page.getByText(t("bot.assignments.attribution.notice"), {
          exact: true,
        }),
      ).toHaveCount(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].method()).toBe("POST");
      expect(requests[0].postDataJSON()).toEqual({
        agentPrefix: label,
        agentIdentityPlacement: "FOOTER",
        expectedRevision: assignment.revision,
      });
    });
  });
}
