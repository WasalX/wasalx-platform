import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getMessages } from "../../lib/i18n/messages/index.ts";

const locale = process.env.WASALX_E2E_LOCALE === "ar" ? "ar" : "en";
const copy = getMessages(locale);
const platformUrl = process.env.WASALX_E2E_PLATFORM_URL;
const storageState = process.env.WASALX_E2E_PLATFORM_STORAGE_STATE;
const listPath = "/api/platform-console/meta-deletion";
const receiptId = "64000000-0000-4000-8000-000000000531";
const reviewPath = `${listPath}/${receiptId}/review`;
const evidence = Buffer.from("Synthetic scope review evidence", "utf8");
const original = {
  id: receiptId,
  receivedAt: "2026-11-25T22:15:00.000Z",
  expiresAt: "2026-12-25T22:15:00.000Z",
  state: "SCOPE_REVIEW_REQUIRED",
  version: 7,
};
const decision = {
  expectedVersion: original.version,
  state: "HELD",
  reason: "OUTCOME_UNRESOLVED",
  evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
};

test.use({ storageState });

for (const scenario of [
  {
    title: "records a decision against the listed receipt version",
    result: 201,
  },
  {
    title: "refreshes the receipt after a stale-version conflict",
    result: 409,
  },
  { title: "shows a denied review without recording a decision", result: 403 },
  {
    title:
      "reconciles a lost response with the original decision and no duplicate write",
    result: 502,
  },
] as const) {
  test(`Meta deletion review ${scenario.title}`, async ({ page }) => {
    expect(
      Boolean(
        platformUrl &&
        storageState &&
        process.env.WASALX_E2E_REUSE_SERVER === "1",
      ),
    ).toBe(true);
    const origin = new URL(platformUrl!).origin;
    await page
      .context()
      .addCookies([{ name: "wasalx_locale", value: locale, url: origin }]);
    await page.clock.setFixedTime(new Date("2026-11-26T12:00:00.000Z"));

    let receipt = original;
    let reads = 0;
    let writes = 0;
    const attempts: {
      method: string;
      key: string | undefined;
      body: unknown;
      hasCsrf: boolean;
    }[] = [];
    await page.route(`**${listPath}`, (route) => {
      reads++;
      return route.fulfill({
        json: { items: [receipt], nextCursor: null, refusalAvailable: false },
      });
    });
    await page.route(`**${reviewPath}`, (route) => {
      const request = route.request();
      const attempt = {
        method: request.method(),
        key: request.headers()["idempotency-key"],
        body: request.postDataJSON(),
        hasCsrf: Boolean(request.headers()["x-wasalx-platform-csrf"]),
      };
      attempts.push(attempt);
      if (scenario.result === 409) {
        receipt = {
          ...original,
          state: "NEEDS_INFORMATION",
          version: original.version + 1,
        };
        return route.fulfill({
          status: 409,
          json: { error: "Receipt version changed" },
        });
      }
      if (scenario.result === 403) {
        return route.fulfill({
          status: 403,
          json: { error: "Review authority revoked" },
        });
      }
      const replay = attempts.length > 1 && attempt.key === attempts[0].key;
      if (!replay) {
        writes++;
        receipt = { ...receipt, state: "HELD", version: receipt.version + 1 };
        if (scenario.result === 502) {
          return route.fulfill({
            status: 502,
            json: { error: "Synthetic lost response" },
          });
        }
      }
      return route.fulfill({
        status: 201,
        json: {
          id: receipt.id,
          state: receipt.state,
          version: receipt.version,
        },
      });
    });

    await page.goto(`${origin}/platform#meta-deletion`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar" ? "rtl" : "ltr",
    );
    const panel = page.locator("#meta-deletion");
    await expect(
      panel.getByRole("heading", {
        name: copy["platform.deletion.reviewTitle"],
      }),
    ).toBeVisible();
    const refresh = panel.getByRole("button", {
      name: copy["platform.deletion.refresh"],
      exact: true,
    });
    await refresh.click();
    await expect(
      panel.getByText(copy["platform.deletion.state.SCOPE_REVIEW_REQUIRED"], {
        exact: false,
      }),
    ).toBeVisible();
    expect(reads).toBe(1);
    await panel
      .getByRole("button", {
        name: copy["platform.deletion.review"],
        exact: true,
      })
      .click();
    await panel
      .getByRole("combobox", { name: copy["platform.deletion.disposition"] })
      .selectOption("HELD");
    await panel.locator('input[type="file"]').setInputFiles({
      name: "scope-proof.txt",
      mimeType: "text/plain",
      buffer: evidence,
    });
    expect(attempts).toEqual([]);

    const review = page.waitForResponse(
      (response) => new URL(response.url()).pathname === reviewPath,
    );
    const save = panel.getByRole("button", {
      name: copy["platform.deletion.saveReview"],
      exact: true,
    });
    await save.click();
    expect((await review).status()).toBe(scenario.result);
    expect(attempts).toEqual([
      {
        method: "POST",
        key: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        body: decision,
        hasCsrf: true,
      },
    ]);

    if (scenario.result !== 201) {
      await expect(panel.getByRole("alert")).toHaveText(
        copy["platform.deletion.reviewFailed"],
      );
    }
    const reconcile = panel.getByRole("button", {
      name: copy["platform.deletion.retry"],
      exact: true,
    });
    if (scenario.result === 409) {
      await expect(save).toHaveCount(0);
      await expect(reconcile).toHaveCount(0);
      await expect(panel.locator("article")).toContainText(
        copy["platform.deletion.state.NEEDS_INFORMATION"],
      );
      expect(reads).toBe(2);
      expect(writes).toBe(0);
      expect(attempts).toHaveLength(1);
      return;
    }
    if (scenario.result === 403) {
      await expect(reconcile).toHaveCount(0);
      await expect(
        panel.getByRole("button", {
          name: copy["platform.deletion.cancel"],
          exact: true,
        }),
      ).toBeEnabled();
      await expect(panel.locator("article")).toContainText(
        copy["platform.deletion.state.SCOPE_REVIEW_REQUIRED"],
      );
      expect(writes).toBe(0);
      expect(attempts).toHaveLength(1);
      return;
    }
    if (scenario.result === 502) {
      // A refresh can observe the committed decision while the original submission remains pending.
      await expect(reconcile).toBeEnabled();
      await refresh.click();
      await expect(panel.locator("article")).toContainText(
        copy["platform.deletion.state.HELD"],
      );
      expect(attempts).toHaveLength(1);
      expect(writes).toBe(1);
      await reconcile.click();
      await expect(reconcile).toHaveCount(0);
      expect(attempts).toEqual([attempts[0], attempts[0]]);
    }
    await expect(save).toHaveCount(0);
    await expect(panel.locator("article")).toContainText(
      copy["platform.deletion.state.HELD"],
    );
    expect(writes).toBe(1);
  });
}
