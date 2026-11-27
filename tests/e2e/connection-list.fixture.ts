import { expect, test, type Page } from "@playwright/test";
import { arabicMessages } from "../../lib/i18n/messages/ar/index.ts";
import { englishMessages } from "../../lib/i18n/messages/en/index.ts";

type ConnectionFixture = { returnsState: "ACTION_REQUIRED" | "PAUSED" };
type DashboardResponse = { data: { connections: Record<string, unknown>[] } };

export function registerConnectionListJourneys(
  locale: "en" | "ar",
  open: (page: Page, view: string) => Promise<void>,
) {
  const messages = locale === "ar" ? arabicMessages : englishMessages;
  const official = messages["tenant.connections.officialWhatsApp"];
  const localizedMethod = messages["tenant.connection.method.official"];
  const operations = "Operations line";
  const returns = "Returns desk";

  async function openList(
    page: Page,
    fixture: ConnectionFixture | null = {
      returnsState: "ACTION_REQUIRED",
    },
  ) {
    await page.route("**/api/dashboard", async (route) => {
      const response = await route.fetch();
      const body: DashboardResponse = await response.json();
      if (fixture) {
        const { connections } = body.data;
        const officialRow = connections.find((row) => row.name === operations);
        const returnsDesk = connections.find((row) => row.name === returns);
        if (!officialRow || !returnsDesk) {
          throw new Error("The two messaging connection fixtures are required");
        }
        Object.assign(officialRow, {
          provider: "META",
          provider_state: "AVAILABLE",
          webhook_state: "ACTIVE",
        });
        returnsDesk.state = fixture.returnsState;
      } else {
        body.data.connections = [];
      }
      await route.fulfill({ response, json: body });
    });
    await open(page, "connections");
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    const panel = page.getByRole("region", {
      name: messages["tenant.connections.messagingTitle"],
      exact: true,
    });
    const table = panel.getByRole("table");
    if (fixture) {
      // The server-rendered dashboard starts with two linked devices.
      await expect(table.getByText(official, { exact: true })).toBeVisible();
    }
    return {
      rows: table.locator("tbody").getByRole("row"),
      search: panel.getByRole("textbox", {
        name: messages["tenant.connections.search"],
        exact: true,
      }),
      method: panel.getByRole("combobox", {
        name: messages["tenant.connections.filterMethod"],
        exact: true,
      }),
      state: panel.getByRole("combobox", {
        name: messages["tenant.connections.filterState"],
        exact: true,
      }),
      emptyTitle: panel.getByText(messages["tenant.connections.emptyTitle"], {
        exact: true,
      }),
      emptyBody: panel.getByText(messages["tenant.connections.emptyBody"], {
        exact: true,
      }),
    };
  }

  test("Messaging connections shows the empty state with zero connections", async ({ page }) => {
    const { rows, emptyTitle, emptyBody } = await openList(page, null);
    await expect(rows).toHaveCount(0);
    await expect(emptyTitle).toBeVisible();
    await expect(emptyBody).toBeVisible();
  });

  for (const [label, query, expected] of [
    ["number", "12025550101", returns],
    ["localized method", localizedMethod, operations],
  ]) {
    test(`Messaging connections search by ${label} shows the matching number`, async ({ page }) => {
      const { rows, search } = await openList(page);
      await expect(rows).toHaveCount(2);
      await search.fill(query);
      await expect(rows).toHaveCount(1);
      await expect(rows.getByText(expected, { exact: true })).toBeVisible();
    });
  }

  test("Messaging connections search with no match shows the empty state", async ({ page }) => {
    const { rows, search, emptyTitle, emptyBody } = await openList(page);
    await expect(rows).toHaveCount(2);
    await search.fill("000000");
    await expect(rows).toHaveCount(0);
    await expect(emptyTitle).toBeVisible();
    await expect(emptyBody).toBeVisible();
  });

  test("Messaging connections method filter shows only official numbers", async ({ page }) => {
    const { rows, method } = await openList(page);
    await expect(rows).toHaveCount(2);
    await method.selectOption({ label: official });
    await expect(rows).toHaveCount(1);
    await expect(rows.getByText(operations, { exact: true })).toBeVisible();
  });

  test("Messaging connections state filter shows only working numbers", async ({ page }) => {
    const { rows, state } = await openList(page);
    await expect(rows).toHaveCount(2);
    await state.selectOption({ label: messages["tenant.status.working"] });
    await expect(rows).toHaveCount(1);
    await expect(rows.getByText(operations, { exact: true })).toBeVisible();
  });

  test("Messaging connections restores all rows when the selected state disappears", async ({ page }) => {
    const fixture: ConnectionFixture = { returnsState: "ACTION_REQUIRED" };
    const { rows, state } = await openList(page, fixture);
    await state.selectOption({
      label: messages["tenant.status.actionRequired"],
    });
    await expect(rows).toHaveCount(1);
    await expect(rows.getByText(returns, { exact: true })).toBeVisible();

    fixture.returnsState = "PAUSED";
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const previousState = state.locator('option[value="ACTION_REQUIRED"]');
    await expect(previousState).toHaveCount(0);
    const allStates = messages["tenant.connections.allStates"];
    await expect(state.locator("option:checked")).toHaveText(allStates);
    await expect(rows).toHaveCount(2);
    await expect(rows.getByText(operations, { exact: true })).toBeVisible();
    await expect(rows.getByText(returns, { exact: true })).toBeVisible();
  });
}
