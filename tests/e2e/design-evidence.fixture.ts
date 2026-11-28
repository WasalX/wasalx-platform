import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { getMessages } from "../../lib/i18n/messages";
import { journeyCapturePath } from "./journey-captures.mjs";

// Whether each element is set in the mono font.
const usesMono = (target: Locator) =>
  target.evaluateAll((elements) =>
    elements.map((element) => /mono/iu.test(getComputedStyle(element).fontFamily)),
  );

export async function captureTenantDesign(
  page: Page,
  testInfo: TestInfo,
  locale: "en" | "ar",
  open: (page: Page, view: string) => Promise<void>,
) {
  const messages = getMessages(locale);
  const ready = {
    inbox: page.getByRole("heading", {
      name: messages["inbox.empty"],
      exact: true,
    }),
    cases: page.getByRole("row", { name: /1234567890.*10382/u }),
    settings: page.getByRole("tabpanel", {
      name: messages["tenant.settings.sections.general"],
      exact: true,
    }),
    groups: page.getByRole("row").filter({
      has: page.getByText("Riyadh \u00b7 Last mile", { exact: true }),
    }),
  };
  await open(page, "overview");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (value) => localStorage.setItem("wasalx.theme", value),
      theme,
    );
    for (const view of [
      "overview",
      "inbox",
      "cases",
      "settings",
      "groups",
    ] as const) {
      await open(page, view);
      if (view !== "overview") await expect(ready[view]).toBeVisible();
      if (view === "settings") {
        await expect(
          ready.settings.getByRole("textbox", {
            name: messages["tenant.settings.general.name"],
            exact: true,
          }),
        ).toHaveValue("Northstar Logistics");
        await expect(
          page.getByText(messages["mailboxes.empty"], { exact: true }),
        ).toBeVisible();
        const mailbox = page.locator(
          'section[aria-labelledby="mailboxes-heading"]',
        );
        const [profile, card, note, prefix, slug] = await Promise.all(
          [
            ready.settings,
            mailbox,
            mailbox.getByText(messages["mailboxes.empty"], { exact: true }),
            ready.settings.locator(".input-prefix > span"),
            ready.settings.locator("#workspace-slug"),
          ].map(async (target) => (await target.boundingBox())!),
        );
        expect(Math.abs(card.x - profile.x)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(card.x + card.width - profile.x - profile.width),
        ).toBeLessThanOrEqual(1);
        // The profile panel and the mailbox card sit one --wx-space-4 apart.
        expect(
          Math.abs(card.y - profile.y - profile.height - 16),
        ).toBeLessThanOrEqual(1);
        expect(note.x - card.x).toBeGreaterThanOrEqual(12);
        expect(
          card.x + card.width - note.x - note.width,
        ).toBeGreaterThanOrEqual(12);
        expect(prefix.x + prefix.width).toBeLessThanOrEqual(slug.x + 1);
        await expect(page.locator(".profile b")).toHaveCSS("direction", "ltr");
        // The version badge is a copyable mono value in one script: a Latin "v" and Latin digits.
        await expect(ready.settings.locator(".settings-version")).toHaveText(/^v[0-9]+$/u);
      }
      await expect(page.locator('[data-application-ready="true"]')).toHaveClass(
        `theme-${theme}`,
      );
      if (view === "overview" || view === "cases") {
        // Durations, states and counts use the interface font; mono is only for values an operator copies.
        const counts =
          view === "overview"
            ? [page.locator(".health-row > strong")]
            : [
                page.getByRole("region", { name: messages["cases.summary.label"], exact: true }).locator("strong"),
                page.getByRole("textbox", { name: messages["cases.search.label"], exact: true }).locator("xpath=../../span"),
              ];
        for (const target of counts) {
          const mono = await usesMono(target);
          expect(mono.length).toBeGreaterThan(0);
          expect(mono).not.toContain(true);
        }
      }
      if (view === "cases") {
        const references = await usesMono(ready.cases.locator(".mono"));
        expect(references.length).toBeGreaterThan(0);
        expect(references).not.toContain(false);
      }
      if (view === "overview" || view === "cases" || view === "groups") {
        // A visible table header band spans its whole scroll wrapper, with no empty scrollbar gutter at the inline end.
        // Phone cards keep their header row only for screen readers, clipped to 1 px.
        const shortfalls = await page.locator(".table-scroll").evaluateAll((wrappers) =>
          wrappers.flatMap((wrapper) => {
            const head = wrapper.querySelector("thead");
            if (!head || head.getBoundingClientRect().height <= 1) return [];
            return [wrapper.getBoundingClientRect().width - head.querySelector("tr")!.getBoundingClientRect().width];
          }),
        );
        if (testInfo.project.name === "desktop") expect(shortfalls.length).toBeGreaterThan(0);
        for (const shortfall of shortfalls) expect(shortfall).toBeLessThanOrEqual(1);
      }
      if (view === "groups") {
        // The search shortcut hint names the modifier key this platform uses.
        const apple = await page.evaluate(() => /Mac|iPhone|iPad/u.test(navigator.platform));
        await expect(page.locator(".search kbd")).toHaveText(apple ? "⌘ K" : "Ctrl K");
      }
      const screen = view === "overview" ? "shell" : view;
      await page.screenshot({
        path: journeyCapturePath(
          `tenant-${screen}`,
          testInfo.project.name,
          theme,
          locale,
        ),
        animations: "disabled",
      });
      if (view === "settings") {
        const tab = (name: keyof typeof messages) =>
          page.getByRole("tab", { name: messages[name], exact: true });
        const general = (await ready.settings.boundingBox())!;
        await tab("tenant.settings.sections.privacy").click();
        const privacy = page.getByRole("tabpanel", {
          name: messages["tenant.settings.sections.privacy"],
          exact: true,
        });
        await expect(
          privacy.getByRole("heading", {
            name: messages["tenant.privacy.requests.title"],
            exact: true,
          }),
        ).toBeVisible();
        const [panel, card] = await Promise.all(
          [
            privacy,
            page.locator('section[aria-labelledby="mailboxes-heading"]'),
          ].map(async (target) => (await target.boundingBox())!),
        );
        expect(Math.abs(card.x - panel.x)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(card.x + card.width - panel.x - panel.width),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(card.y - panel.y - panel.height - 16),
        ).toBeLessThanOrEqual(1);
        // Every Settings section fills the same column, so General is as wide as Privacy & retention.
        expect(Math.abs(general.x - panel.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(general.width - panel.width)).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: journeyCapturePath(
            "tenant-settings-privacy",
            testInfo.project.name,
            theme,
            locale,
          ),
          animations: "disabled",
        });
        // The selected tab persists in session storage; the next theme starts on General.
        await tab("tenant.settings.sections.general").click();
        await expect(ready.settings).toBeVisible();
      }
    }
  }
}

export async function verifyRuleModalLabels(
  page: Page,
  testInfo: TestInfo,
  locale: "en" | "ar",
) {
  const messages: Readonly<Record<string, string>> = getMessages(locale);
  const t = (key: string) => messages[`tenant.rules.${key}`]!;
  await page
    .getByRole("button", { name: t("new") })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: t("modal.title"),
    exact: true,
  });
  await expect(dialog).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
  for (const label of [
    "modal.name",
    "modal.matcherType",
    "teamPolicy",
    "modal.digitLength",
    "modal.representativeMessage",
  ]) {
    await expect(dialog.getByLabel(t(label))).toBeVisible();
  }
  const matcher = dialog.getByRole("combobox", {
    name: t("modal.matcherType"),
    exact: true,
  });
  await matcher.selectOption("prefix_length");
  await expect(
    dialog.getByRole("textbox", { name: t("modal.prefix"), exact: true }),
  ).toBeVisible();
  await matcher.selectOption("advanced");
  await expect(
    dialog.getByRole("textbox", { name: t("modal.safeExpression") }),
  ).toBeVisible();
  await dialog.getByRole("checkbox", { name: t("command.enable") }).check();
  await expect(
    dialog.getByRole("combobox", { name: t("command.action") }),
  ).toBeVisible();
  for (const label of [
    "modal.literalPattern",
    "command.inputKey",
    "command.inputValue",
    "command.successReply",
    "command.failureReply",
  ]) {
    await expect(dialog.getByLabel(t(label))).toBeVisible();
  }
  await testInfo.attach(`rule-modal-${locale}-${testInfo.project.name}`, {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
}
