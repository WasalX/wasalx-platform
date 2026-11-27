import { expect, test, type Locator, type Page } from "@playwright/test";
import { getMessages } from "../../lib/i18n/messages";
import { journeyCapturePath } from "./journey-captures.mjs";

export function registerOperationsScreenshots(locale: "en" | "ar") {
  const messages = getMessages(locale);
  const deliveryRow = (page: Page) =>
    page.getByRole("row", { name: /Riyadh · Last mile/u });
  const routingEditor = (page: Page) =>
    page.getByRole("heading", {
      name: messages["routing.editor.title"],
      exact: true,
    });
  const screens = [
    {
      area: "workflow-automation",
      view: "automation",
      state: "edit",
      listReady: (page: Page) =>
        page
          .locator("#bot-panel-flows .bot-version-list")
          .getByRole("button", { name: /Customer care/u, pressed: true }),
      open: (page: Page) =>
        page.getByRole("button", {
          name: messages["bot.flows.new"],
          exact: true,
        }),
      detailReady: (page: Page) =>
        page.getByLabel(messages["bot.canvas.minimap"], { exact: true }),
      editorHeading: (page: Page) =>
        page.getByRole("heading", {
          name: messages["bot.editor.title"],
          exact: true,
        }),
    },
    {
      area: "client-routing",
      view: "routing",
      state: "edit",
      listReady: (page: Page) =>
        page
          .getByRole("region", {
            name: messages["routing.clients.tableLabel"],
            exact: true,
          })
          .getByText("Acme Logistics", { exact: true }),
      open: (page: Page) =>
        page.getByRole("button", {
          name: messages["routing.versions.new"],
          exact: true,
        }),
      detailReady: routingEditor,
      editorHeading: routingEditor,
    },
    {
      area: "message-delivery",
      view: "deliveries",
      state: "detail",
      listReady: deliveryRow,
      open: (page: Page) =>
        deliveryRow(page).getByRole("button", {
          name: messages["tenant.deliveries.actions.inspect"],
          exact: true,
        }),
      detailReady: (page: Page) =>
        page
          .getByRole("dialog", {
            name: messages["tenant.deliveries.detail.title"],
            exact: true,
          })
          .getByRole("heading", {
            name: messages["tenant.deliveries.detail.currentState"],
            exact: true,
          }),
    },
  ];

  for (const screen of screens) {
    // Playwright gives each theme its own storage so a saved draft cannot carry over.
    for (const theme of ["dark", "light"] as const) {
      test(`Owner captures ${screen.area} in ${theme}`, async ({
        page,
      }, testInfo) => {
        const application = page.locator('[data-application-ready="true"]');
        await page.goto(`/app?view=${screen.view}`);
        await expect(application).toHaveAttribute("data-locale", locale);
        if (theme === "light") {
          await page
            .getByRole("button", {
              name: messages["tenant.theme.switchLight"],
              exact: true,
            })
            .click();
        }

        const capture = async (state: string, ready: Locator) => {
          await expect(ready).toBeVisible();
          await expect(application).toHaveCSS("color-scheme", theme);
          // The root canvas follows the theme, so a full-page capture never ends in a white band.
          const background = (target: Locator) =>
            target.evaluate(
              (element) => getComputedStyle(element).backgroundColor,
            );
          expect(await background(page.locator("html"))).toBe(
            await background(application),
          );
          if (screen.area === "message-delivery" && state === "list") {
            // Every delivery's status and actions fit without sideways scrolling, on phones too.
            const table = page.locator(".table-scroll").filter({ has: ready });
            expect(
              await table.evaluate(
                (element) => element.scrollWidth - element.clientWidth,
              ),
            ).toBeLessThanOrEqual(0);
            // On phone cards each status badge ends at the inline end of its row, in both directions.
            const badgeGaps = await table
              .locator("tbody tr")
              .evaluateAll((rows) =>
                rows
                  .filter((row) => getComputedStyle(row).display === "grid")
                  .map((row) => {
                    const style = getComputedStyle(row);
                    const box = row.getBoundingClientRect();
                    const badge = row
                      .querySelector("td:nth-child(4) .status")!
                      .getBoundingClientRect();
                    return style.direction === "rtl"
                      ? badge.left - box.left - parseFloat(style.paddingLeft)
                      : box.right - parseFloat(style.paddingRight) - badge.right;
                  }),
              );
            if (testInfo.project.name === "mobile-390") {
              expect(badgeGaps.length).toBeGreaterThan(0);
            }
            for (const gap of badgeGaps) {
              expect(Math.abs(gap)).toBeLessThanOrEqual(1);
            }
            // The italic redacted excerpt keeps its slanted last glyph unless the text really overflows.
            const clippedExcerpts = await table
              .locator(".redacted-message .excerpt")
              .evaluateAll((excerpts) => {
                const context = document
                  .createElement("canvas")
                  .getContext("2d")!;
                return excerpts.filter((excerpt) => {
                  const style = getComputedStyle(excerpt);
                  if (
                    style.fontStyle !== "italic" ||
                    style.direction === "rtl" ||
                    excerpt.scrollWidth > excerpt.clientWidth
                  ) {
                    return false;
                  }
                  context.font = style.font;
                  const ink = context.measureText(
                    excerpt.textContent ?? "",
                  ).actualBoundingBoxRight;
                  return (
                    parseFloat(style.paddingLeft) + ink >
                    excerpt.getBoundingClientRect().width
                  );
                }).length;
              });
            expect(clippedExcerpts).toBe(0);
          }
          const fullPage = state !== "detail";
          if (fullPage) {
            await page.evaluate(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
            await expect
              .poll(() => page.evaluate(() => window.scrollY))
              .toBe(0);
          }
          await page.screenshot({
            path: journeyCapturePath(
              `${screen.area}-${state}`,
              testInfo.project.name,
              theme,
              locale,
            ),
            fullPage,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });
        };
        await capture("list", screen.listReady(page));
        await screen.open(page).click();
        // Wait for the editor's autofocus and scroll before resetting the page position.
        if (screen.editorHeading)
          await expect(screen.editorHeading(page)).toBeFocused();
        if (screen.area === "workflow-automation") {
          await expect(
            page.getByText(messages["bot.notice.recovered"], { exact: true }),
          ).toHaveCount(0);
        }
        await capture(screen.state, screen.detailReady(page));
      });
    }
  }
}
