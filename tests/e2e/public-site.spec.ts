import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createDemoWorkspace } from "../../app/marketing-workspace.ts";
import { englishMarketingMessages } from "../../lib/i18n/messages/en/marketing.ts";
import { arabicMarketingMessages } from "../../lib/i18n/messages/ar/marketing.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";

const locale = process.env.WASALX_E2E_LOCALE ?? "en";
const arabic = locale === "ar";
test.skip((process.env.WASALX_E2E_ROLE ?? "tenant_owner") !== "tenant_owner", "The public surface has no tenant role.");

async function openChooser(page: Page) {
  const chooser = page.locator(".inbox-browse-toggle");
  if (await chooser.isVisible() && await chooser.getAttribute("aria-expanded") === "false") await chooser.click();
}

test("landing icons stay centered with touch and mouse input", async ({ browser }, testInfo) => {
  for (const hasTouch of [false, true]) {
    const context = await browser.newContext({ ...testInfo.project.use, hasTouch, reducedMotion: "no-preference" });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await expect(page.locator(".marketing-motion-toggle")).toBeVisible();
      const checkIcons = async () => {
        const failures = await page.locator(".marketing-shell .marketing-icon").evaluateAll(icons => icons.flatMap(icon => {
          const bounds = icon.getBoundingClientRect();
          if (!icon.checkVisibility() || !bounds.width || !bounds.height) return [];
          const parent = icon.parentElement!;
          const box = parent.getBoundingClientRect();
          const style = getComputedStyle(parent);
          const contentCenterY = (box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom)) / 2;
          const name = `${parent.className} > ${icon.getAttribute("class")}`;
          const centered = parent.matches(".marketing-theme-toggle, .inbox-icon-button, .inbox-source-icon, .inbox-composer button[type=submit]") ||
            (parent.matches(".marketing-motion-toggle") && !parent.querySelector("span")!.checkVisibility());
          const errors = [];
          if (centered && (Math.abs(bounds.x + bounds.width / 2 - box.x - box.width / 2) > 1 || Math.abs(bounds.y + bounds.height / 2 - box.y - box.height / 2) > 1)) errors.push(`${name}: off center`);
          if (parent.matches("button, a.wx-button") && Math.abs(bounds.y + bounds.height / 2 - contentCenterY) > 1) errors.push(`${name}: vertically misaligned`);
          if (parent.matches("button, a, .inbox-source-icon") && (bounds.x < box.x - 1 || bounds.right > box.right + 1 || bounds.y < box.y - 1 || bounds.bottom > box.bottom + 1)) errors.push(`${name}: outside control`);
          if (centered && parent.matches("button") && matchMedia("(pointer: coarse)").matches && (box.width < 44 || box.height < 44)) errors.push(`${name}: small touch target`);
          return errors;
        }));
        expect(failures, `touch=${hasTouch}, theme=${await page.locator(".marketing-shell").getAttribute("class")}`).toEqual([]);
      };
      await checkIcons();
      await page.locator(".marketing-motion-toggle").click();
      await expect(page.locator(".marketing-motion-toggle .marketing-icon-play")).toBeVisible();
      await page.locator(".inbox-views button").first().click();
      for (const theme of ["light", "dark"]) {
        if (theme === "dark") await page.locator(".marketing-theme-toggle").click();
        await checkIcons();
        await page.locator("#demo-reply").fill("1234567890");
        await checkIcons();
        await page.locator("#demo-reply").fill("");
        await page.locator(".inbox-request-reply").first().click();
        await expect(page.locator(".inbox-icon-button")).toBeVisible();
        await checkIcons();
        await page.locator(".inbox-icon-button").click();
        await page.locator(".inbox-views button").last().click();
        await openChooser(page);
        for (const tool of ["filter", "group", "sort"]) {
          await page.locator(`[data-panel="${tool}"]`).click();
          if (tool === "filter") await page.locator('[name="demo-status-filter"]').selectOption("open");
          await checkIcons();
          if (tool === "filter") await page.locator('[name="demo-status-filter"]').selectOption("");
        }
        await page.locator(".inbox-views button").first().click();
      }
      await page.locator(".marketing-motion-toggle").click();
      await expect(page.locator(".marketing-icon-pause")).toBeVisible();
      await checkIcons();
    } finally {
      await context.close();
    }
  }
});

test("landing theme is accessible, remembered and rendered before hydration", async ({ page }) => {
  await page.goto("/");
  const shell = page.locator(".marketing-shell");
  await expect(shell).toHaveClass(/theme-light/u);
  await page.getByRole("button", { name: arabic ? "التبديل إلى المظهر الداكن" : "Switch to dark theme" }).click();
  await expect(shell).toHaveClass(/theme-dark/u);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("wasalx.theme"))).toBe("dark");
  await page.locator("#demo-reply").fill(arabic ? "رسالة تجريبية" : "Example message");
  await page.locator(".inbox-composer button[type=submit]").click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(shell).toHaveClass(/theme-dark/u);
  const html = await (await page.request.get("/")).text();
  expect(html).toContain('class="marketing-shell theme-dark"');
  expect(html).toMatch(/<meta name="color-scheme" content="dark"/u);
  await page.getByRole("button", { name: arabic ? "English" : "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", arabic ? "en" : "ar");
  await expect(shell).toHaveClass(/theme-dark/u);
  await page.getByRole("button", { name: arabic ? "Switch to light theme" : "التبديل إلى المظهر الفاتح" }).click();
  await expect(shell).toHaveClass(/theme-light/u);
  await page.reload();
  await expect(shell).toHaveClass(/theme-light/u);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
});

test("public shared inbox explains channels, ownership and pricing in both languages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("dir", arabic ? "rtl" : "ltr");
  await expect(page.locator("h1")).toContainText(arabic ? "كل محادثاتك" : "All your conversations.");
  await expect(page.getByRole("heading", { name: arabic ? "قروبات عملائك. وكل طلب له متابعة." : "Customer groups. Every request tracked." })).toBeVisible();
  await expect(page.locator(".marketing-channels")).toContainText(arabic ? "قريبًا" : "Coming soon");
  await expect(page.getByRole("group", { name: arabic ? "قريبًا" : "Coming soon", exact: true })).toContainText(arabic ? "إنستقرام" : "Instagram");
  await page.locator('.inbox-views button').nth(1).click();
  await openChooser(page);
  for (const scope of [".marketing-channels", ".inbox-sidebar"]) {
    await expect(page.locator(scope)).toContainText(scope === ".marketing-channels" ? (arabic ? "واتساب · بوتات وقروبات" : "WhatsApp Bots & Groups") : (arabic ? "بوت واتساب" : "WhatsApp bot"));
    for (const channel of arabic ? ["إنستقرام", "إكس", "تيك توك", "سلاك"] : ["Instagram", "X", "TikTok", "Slack"]) await expect(page.locator(scope)).toContainText(channel);
    for (const channel of ["whatsapp", "instagram", "x", "tiktok", "slack"]) await expect(page.locator(scope + " .marketing-icon-" + channel).first()).toBeVisible();
  }
  const heroChannels = page.locator(".marketing-channels > ul > li");
  await expect(heroChannels).toHaveText(arabic ? ["واتساب · بوتات وقروبات", "الإيميل"] : ["WhatsApp Bots & Groups", "Email"]);
  expect(await heroChannels.evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor))).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  await expect(page.locator(".inbox-team-heading")).toHaveText(arabic ? ["العمليات", "المبيعات", "خدمة العملاء", "الدعم الفني"] : ["Operations", "Sales", "Customer support", "Technical support"]);
  await expect(page.locator("#product .inbox-conversation-header")).toContainText("#1042");
  await expect(page.locator(".marketing-bot-channels")).toContainText(arabic ? "بوتات أكثر · قريبًا" : "More bots · Coming soon");
  const groupExample = page.locator(".marketing-group-example");
  await expect(groupExample.locator(".marketing-group-ticket")).toContainText("#1042");
  await expect(groupExample.locator(".marketing-group-rule")).toContainText(arabic ? "رقم مرجعي · 10 خانات" : "Reference number · 10 digits");
  await expect(groupExample.locator("mark")).toHaveText("1234567890");
  await expect(groupExample.locator(".inbox-trigger-label")).toHaveText(arabic ? "رسالة تفتح تذكرة" : "Trigger message");
  await expect(page.locator('#product [data-origin="0"] .inbox-trigger-label')).toHaveText(arabic ? "رسالة تفتح تذكرة" : "Trigger message");
  await expect(page.locator('#product [data-origin="0"] mark')).toHaveText("1234567890");
  await expect(page.locator('#product .inbox-message-followup .inbox-trigger-label')).toHaveCount(0);
  await expect(page.locator('#product blockquote mark, #product .inbox-message-outbound mark')).toHaveCount(0);
  await expect(groupExample.locator(".inbox-ticket-state")).toHaveText(arabic ? "مفتوحة" : "Open");
  await expect(groupExample.locator(".inbox-message-outbound blockquote")).toContainText(arabic ? "منى" : "Mona");
  await expect(groupExample.locator(".inbox-message-outbound blockquote")).toContainText(arabic ? "فيه أي تحديث؟" : "Any update on this?");
  expect(await page.locator(".marketing-bot-channels ul").evaluate(el => getComputedStyle(el).justifyContent)).toBe("center");
  await expect(page.locator("#product .inbox-message-followup blockquote")).toContainText("1234567890");
  await expect(page.locator(".inbox-upcoming")).toContainText(arabic ? "قريبًا" : "Coming soon");
  await expect(page.locator("#contact a").first()).toHaveAttribute("href", arabic ? "mailto:contact@example.invalid" : "mailto:contact@example.invalid");
  const contact = await page.locator(".marketing-contact-actions").evaluate(element => {
    const [button, address] = [...element.children].map(child => child.getBoundingClientRect());
    return { gap: address.top - button.bottom, offset: Math.abs(address.left + address.width / 2 - button.left - button.width / 2) };
  });
  expect(contact.gap).toBeGreaterThanOrEqual(12);
  expect(contact.offset).toBeLessThan(1);
  const workflow = page.getByRole("figure", { name: arabic ? "أمثلة على سير العمل" : "Example workflows" });
  await expect(workflow.getByRole("region", { name: arabic ? "استعلم عن طلب" : "Check an order", exact: true })).toBeVisible();
  await expect(workflow.getByRole("region", { name: arabic ? "حوّل المحادثة للفريق المناسب" : "Route a conversation", exact: true })).toContainText(arabic ? "مبيعات أو دعم" : "Sales or support");
  await expect(workflow.getByRole("region", { name: arabic ? "خلّ القروب على اطلاع" : "Keep the group updated", exact: true })).toContainText(arabic ? "باقتباس آخر رسالة بالتذكرة" : "Quote the latest ticket message");
  await expect(workflow).toContainText(arabic ? "قروب واتساب" : "WhatsApp group");
  await expect(workflow).toContainText("/status ORD-42");
  await expect(workflow).toContainText(arabic ? "محادثة البوت" : "Bot conversation");
  await expect(workflow.locator(".marketing-flow-action")).toContainText(arabic ? "استعلم عن حالة الطلب" : "Check order status");
  await expect(workflow).toContainText(arabic ? "تم شحن طلبك." : "Your order has shipped.");
  await expect(workflow).toContainText(arabic ? "انغلقت التذكرة" : "Ticket closed");
  await expect(workflow.locator("button, input, select, a")).toHaveCount(0);
  await expect(page.getByRole("link", { name: arabic ? "تسجيل الدخول" : "Sign in", exact: true })).toHaveAttribute("href", "/auth/login?return_to=/app");
  const names = arabic ? ["فهد", "سارة", "نورة", "خالد"] : ["Fahad", "Sara", "Noura", "Khalid"];
  for (const index of [1, 2, 3, 0]) {
    await openChooser(page);
    await page.locator(`.inbox-row[value="${index}"]`).click();
    await expect(page.locator(`.inbox-row[value="${index}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#inbox-conversation .inbox-assignment")).toContainText(names[index]);
    await page.locator('#demo-reply').fill('Reply ' + names[index]);
    await page.locator('.inbox-composer button[type=submit]').click();
    await expect(page.locator('#inbox-conversation .inbox-message-outbound').filter({hasText:'Reply ' + names[index]})).toHaveCount(1);
  }
  expect(await page.locator(".inbox-window").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: arabic ? "English" : "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", arabic ? "en" : "ar");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", arabic ? "ltr" : "rtl");
  await expect(page.locator("#contact a").first()).toHaveAttribute("href", arabic ? "mailto:contact@example.invalid" : "mailto:contact@example.invalid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("example links group threads and tickets, keeps chatter separate, and filters real sample data", async ({ page }) => {
  const mutations: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.url()); });
  await page.goto("/");
  const demo = page.locator("#product");
  const draft = page.locator("#demo-reply");
  const send = page.locator(".inbox-composer button[type=submit]");
  const groupTab = page.locator(".inbox-views button").nth(0);
  const ticketTab = page.locator(".inbox-views button").nth(1);
  const greeting = arabic ? "صباح الخير! جاهزين نستلم شحنتنا." : "Morning! We’re ready to receive our delivery.";
  await expect(demo).toHaveAttribute("data-view", "groups");
  await expect(demo.locator(".inbox-sender-name")).toHaveText(arabic ? "أحمد" : "Ahmed");
  await expect(demo.locator('.inbox-sender-switch button[aria-pressed="true"]')).toHaveText(arabic ? "العميل" : "Customer");
  await expect(demo.getByText(greeting, { exact: true })).toHaveCount(1);
  await expect(send).toBeDisabled();
  await draft.fill("   ");
  await expect(send).toBeDisabled();
  await draft.fill("Group-only note");
  await send.click();
  await expect(demo.getByText("Group-only note", { exact: true })).toHaveCount(1);
  await expect(demo.locator(".inbox-history-entry").last().locator(".inbox-trigger-label")).toHaveCount(0);
  await page.locator("#product .inbox-original .inbox-trigger button").first().focus();
  await page.keyboard.press("Enter");
  await expect(demo).toHaveAttribute("data-view", "tickets");
  await expect(demo.locator("#inbox-conversation")).toBeFocused();
  await expect(demo.getByText(greeting, { exact: true })).toHaveCount(0);
  await expect(demo.getByText("Group-only note", { exact: true })).toHaveCount(0);
  await expect(demo.locator(".inbox-message-followup blockquote")).toContainText("1234567890");
  const previousTicketReply = arabic ? "بنتأكد ونرجع لكم هنا." : "We’ll check and update you here.";
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText(previousTicketReply);
  await draft.fill("Ticket reply <b>stays text</b>");
  await groupTab.click();
  await ticketTab.click();
  await expect(draft).toHaveValue("Ticket reply <b>stays text</b>");
  await send.click();
  const ticketReply = demo.locator(".inbox-message-outbound").filter({ has: page.locator("p", { hasText: "Ticket reply <b>stays text</b>" }) });
  await expect(ticketReply).toHaveCount(1);
  await expect(ticketReply.locator("blockquote")).toContainText(previousTicketReply);
  await expect(ticketReply.locator("blockquote")).not.toContainText("1234567890");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Ticket reply <b>stays text</b>");
  await expect(ticketReply.locator("b")).toHaveCount(0);
  await demo.getByRole("button", { name: arabic ? "شوفها بالقروب" : "View in group" }).click();
  await expect(demo.locator("#inbox-conversation")).toBeFocused();
  await expect(ticketReply).toHaveCount(1);
  await expect(demo.getByText("Group-only note", { exact: true })).toHaveCount(1);
  await expect(ticketReply).toBeInViewport();
  await demo.locator(".inbox-original .inbox-request-reply").click();
  await expect(draft).toBeFocused();
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Ticket reply <b>stays text</b>");
  await draft.fill("Linked reply from group view");
  await send.click();
  await ticketTab.click();
  await expect(demo.locator(".inbox-message-outbound p").filter({ hasText: "Linked reply from group view" })).toHaveCount(1);
  await expect(demo.getByText("Group-only note", { exact: true })).toHaveCount(0);
  await expect(demo.locator(".inbox-message-outbound").filter({ has: page.locator("p", { hasText: "Linked reply from group view" }) }).locator("blockquote")).toContainText("Ticket reply <b>stays text</b>");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Linked reply from group view");
  await expect(ticketReply.locator("blockquote")).toContainText(previousTicketReply);
  await groupTab.click();
  await draft.fill("Newer unrelated group chatter");
  await send.click();
  await ticketTab.click();
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Linked reply from group view");
  await expect(demo.getByText("Newer unrelated group chatter", { exact: true })).toHaveCount(0);
  const longReply = "Message".repeat(70);
  await draft.fill(longReply);
  await send.click();
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText(longReply);
  await draft.fill("A reply after the long message");
  await send.click();
  const longQuote = demo.locator(".inbox-message-outbound").filter({ has: page.locator("p", { hasText: "A reply after the long message" }) }).locator("blockquote span");
  await expect(longQuote).toHaveText(longReply);
  expect(await longQuote.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeLessThanOrEqual(2.1);

  await openChooser(page);
  await demo.locator('[data-panel="group"]').click();
  await demo.locator("select[name=demo-group-by]").selectOption("member");
  await expect(demo.locator(".inbox-team-heading")).toHaveText(arabic ? ["فهد", "سارة", "نورة", "خالد"] : ["Fahad", "Sara", "Noura", "Khalid"]);
  await demo.locator("select[name=demo-group-by]").selectOption("");
  await expect(demo.locator(".inbox-team-heading")).toHaveCount(0);
  await demo.locator('[data-panel="filter"]').click();
  await demo.locator("select[name=demo-team]").selectOption(arabic ? "العمليات" : "Operations");
  await expect(demo.locator(".inbox-row")).toHaveCount(3);
  await demo.locator("select[name=demo-member]").selectOption(arabic ? "سارة" : "Sara");
  await expect(demo.locator(".inbox-row")).toHaveCount(0);
  await expect(demo.locator("#demo-reply")).toHaveCount(0);
  await demo.locator(".inbox-empty-detail button").click();
  await expect(demo.locator(".inbox-row")).toHaveCount(18);
  await demo.locator("select[name=demo-member]").selectOption(arabic ? "سارة" : "Sara");
  await expect(demo.locator(".inbox-row")).toHaveCount(6);
  await expect(demo.locator(".inbox-conversation-header")).toContainText(arabic ? "بوت واتساب" : "WhatsApp bot");
  await draft.fill("Sales draft");
  await groupTab.click();
  await openChooser(page);
  await demo.locator(".inbox-row").nth(1).click();
  await expect(demo.locator(".inbox-conversation-header")).toContainText("32");
  await draft.fill("Store group only");
  await send.click();
  await expect(demo.getByText("Store group only", { exact: true })).toHaveCount(1);
  await ticketTab.click();
  await expect(draft).toHaveValue("Sales draft");
  await expect(demo.getByText("Store group only", { exact: true })).toHaveCount(0);
  await expect(demo.locator(".inbox-conversation-header")).toContainText(arabic ? "بوت واتساب" : "WhatsApp bot");
  await demo.getByRole("button", { name: arabic ? "من جديد" : "Reset", exact: true }).click();
  await expect(demo).toHaveAttribute("data-view", "groups");
  await expect(draft).toHaveValue("");
  await expect(demo.getByText("Group-only note", { exact: true })).toHaveCount(0);
  await ticketTab.click();
  await expect(demo.locator(".inbox-message-outbound blockquote")).toBeInViewport();
  await expect(demo.locator(".inbox-message-outbound blockquote")).toContainText(arabic ? "فيه أي تحديث؟" : "Any update on this?");
  await demo.locator(".inbox-origin").click();
  await expect(demo.locator(".inbox-original")).toBeInViewport();
  await groupTab.click();
  const chooser = demo.locator(".inbox-browse-toggle");
  if (await chooser.isVisible()) {
    await expect(demo.locator(".inbox-browser")).toBeHidden();
    await chooser.click();
    await demo.locator(".inbox-row").first().focus();
    await page.keyboard.press("Escape");
    await expect(chooser).toBeFocused();
    await expect(demo.locator(".inbox-browser")).toBeHidden();
    await chooser.click();
    await demo.locator(".inbox-row").nth(1).click();
    await expect(demo.locator(".inbox-browser")).toBeHidden();
    await expect(demo.locator("#inbox-conversation")).toBeFocused();
  }
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test.describe("page language independent of browser language", () => {
test.use({ locale: arabic ? "en-US" : "ar-SA" });
test("active group rules preserve history and compact sort controls work", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#product");
  const trigger = demo.getByRole("button", { name: arabic ? "شرط التذكرة" : "Trigger", exact: true });
  const save = demo.locator(".inbox-trigger-editor button[type=submit]");
  const pattern = demo.locator('[name="demo-pattern"]');
  const send = demo.locator(".inbox-composer button[type=submit]");
  await expect(demo.locator('[name="demo-sample"], .inbox-walkthrough')).toHaveCount(0);
  await expect(demo.locator(".inbox-active-rule")).toContainText("10");
  await trigger.click();
  await demo.locator('[name="demo-rule"]').selectOption("contains");
  await pattern.fill(""); await save.click();
  await expect(demo.locator(".inbox-trigger-editor")).toBeVisible();
  await expect(demo.locator(".inbox-active-rule")).toContainText("10");
  await pattern.fill("ORDER");
  await demo.getByRole("button", { name: arabic ? "إلغاء" : "Cancel", exact: true }).click();
  await trigger.click();
  await expect(demo.locator('[name="demo-rule"]')).toHaveValue("digits");
  await demo.locator('[name="demo-rule"]').selectOption("contains");
  await pattern.fill("  ORDER "); await save.click();
  await expect(demo.locator(".inbox-trigger-editor")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(demo.locator(".inbox-active-rule")).toContainText("ORDER");
  await expect(demo.locator(".inbox-original p")).toContainText("1234567890");
  await expect(demo.locator(".inbox-original mark")).toHaveText("1234567890");
  await demo.locator("#demo-reply").fill("Your order is delayed"); await send.click();
  await expect(demo.locator(".inbox-history-entry").last()).toContainText("#1060");
  await expect(demo.locator(".inbox-history-entry").last().locator("mark")).toHaveText("order");
  await demo.locator("#demo-reply").fill("Another ORDER update"); await send.click();
  await expect(demo.locator(".inbox-history-entry").last()).toContainText("#1060");
  await demo.locator("#demo-reply").fill("Good morning"); await send.click();
  await expect(demo.locator(".inbox-history-entry").last().locator(".inbox-trigger")).toHaveCount(0);
  for (let index = 0; index < 6; index++) {
    await openChooser(page);
    await demo.locator('.inbox-row[value="' + index + '"]').click();
    await expect(demo.locator(".inbox-conversation-header")).toContainText(String([25,32,28,36,42,26][index]));
    await expect(demo.locator(".inbox-active-rule")).toContainText(index === 0 ? "ORDER" : ["", "ST-", "SO-", "12", "WH-", "IT-"][index]);
    await demo.locator(".inbox-related-toggle").click();
    await expect(demo.locator(".inbox-related-row")).toHaveCount(index === 0 ? 3 : 2);
  }
  await demo.locator(".inbox-views button").nth(1).click();
  await openChooser(page);
  await expect(demo.locator(".inbox-row")).toHaveCount(19);
  await demo.locator('[data-panel="group"]').click();
  await demo.locator('[name="demo-group-by"]').selectOption("");
  await demo.locator('[data-panel="sort"]').click();
  await demo.locator('[name="demo-sort"]').selectOption("name");
  const titles = await demo.locator(".inbox-row strong").allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, locale)));
  await expect(demo.locator('.inbox-row[value="0"]')).toHaveAttribute("aria-pressed", "true");
  await demo.locator('[name="demo-sort"]').selectOption("recent");
  await demo.locator('[name="demo-sort"]').focus();
  await page.keyboard.press("Escape");
  await expect(demo.locator('[data-panel="sort"]')).toBeFocused();
  await expect(demo.locator(".inbox-filters")).toHaveCount(0);
  await demo.locator('.inbox-row[value="2"]').click();
  await demo.locator("#demo-reply").fill("Email is most recent now");
  await demo.locator(".inbox-composer button[type=submit]").click();
  await openChooser(page);
  await expect(demo.locator(".inbox-row").first()).toHaveAttribute("value", "2");
  await expect(demo.locator(".inbox-upcoming")).toContainText(arabic ? "سلاك" : "Slack");
  await demo.locator('[data-panel="filter"]').click();
  await demo.locator(".inbox-views button").first().click();
  const chooser = demo.locator(".inbox-browse-toggle");
  if (await chooser.isVisible()) {
    await chooser.click();
    await demo.locator(".inbox-row").first().focus();
    await page.keyboard.press("Escape");
    await expect(chooser).toBeFocused();
    await expect(demo.locator(".inbox-browser")).toBeHidden();
  }
  expect((await new AxeBuilder({ page }).include("#product").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
});

test("saved trigger rules match references and keep every linked ticket navigable", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#product");
  const trigger = demo.getByRole("button", { name: arabic ? "شرط التذكرة" : "Trigger", exact: true });
  const save = demo.locator(".inbox-trigger-editor button[type=submit]");
  const post = async (text: string) => { await demo.locator("#demo-reply").fill(text); await demo.locator(".inbox-composer button[type=submit]").click(); };
  for (const [rule, count, message, matched, highlights] of [
    ["digits", "10", "Reference 1234567890", true, ["1234567890"]],
    ["digits", "10", "Reference 123456789012", false, []],
    ["digits", "12", "Reference 123456789012", true, ["123456789012"]],
    ["digits", "7", "Reference 1234567", true, ["1234567"]],
    ["digits", "7", "Reference 12345678", false, []],
    ["digits", "10", "الشحنة ١٢٣٤٥٦٧٨٩٠", true, ["١٢٣٤٥٦٧٨٩٠"]],
    ["digits", "10", "📦 <b>۱۲۳۴۵۶۷۸۹۰</b>", true, ["۱۲۳۴۵۶۷۸۹۰"]],
    ["prefix", "4", "Check wx-0012", true, ["wx-0012"]],
    ["prefix", "4", "Check wx-00123", false, []],
    ["prefix", "4", "Check awx-0012", false, []],
    ["prefix", "4", "WX-٠٠١٢", true, ["WX-٠٠١٢"]],
  ] as const) {
    await trigger.click();
    await demo.locator('[name="demo-rule"]').selectOption(rule);
    await demo.locator('[name="demo-digits"]').fill(count);
    if (rule === "prefix") {
      await demo.locator('[name="demo-prefix"]').fill("WX-");
      expect(await demo.locator('[name="demo-prefix"]').evaluate(el => getComputedStyle(el).direction)).toBe("ltr");
    }
    await save.click(); await post(message);
    await expect(demo.locator(".inbox-history-entry").last().locator("p")).toHaveText(message);
    await expect(demo.locator(".inbox-history-entry").last().locator(".inbox-trigger")).toHaveCount(Number(matched));
    await expect(demo.locator(".inbox-history-entry").last().locator("mark")).toHaveText([...highlights]);
    await expect(demo.locator(".inbox-history-entry").last().locator("p b")).toHaveCount(0);
  }
  await trigger.click();
  await demo.locator('[name="demo-rule"]').selectOption("digits");
  for (const invalid of ["", "0", "65", "1.5"]) {
    await demo.locator('[name="demo-digits"]').fill(invalid); await save.click();
    expect(await demo.locator('[name="demo-digits"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
    await expect(demo.locator(".inbox-active-rule")).toContainText("WX-");
  }
  await demo.locator('[name="demo-digits"]').fill("10"); await save.click();
  await post("1111111111 2222222222 2222222222");
  await expect(demo.locator(".inbox-history-entry").last().locator(".inbox-trigger-label")).toBeVisible();
  await expect(demo.locator(".inbox-history-entry").last().locator("mark")).toHaveText(["1111111111", "2222222222", "2222222222"]);
  const ids = await demo.locator(".inbox-history-entry").last().locator(".inbox-trigger bdi").allTextContents();
  expect(ids).toHaveLength(2);
  for (const id of ids) {
    await demo.locator(".inbox-history-entry").last().getByRole("button", { name: (arabic ? "تذكرة " : "Ticket ") + id, exact: true }).click();
    await expect(demo.locator(".inbox-conversation-header")).toContainText(id);
    await demo.locator("#demo-reply").fill("Reply for " + id); await demo.locator(".inbox-composer button[type=submit]").click();
    await demo.locator(".inbox-origin").click();
    const origin = demo.locator('[data-origin~="' + (Number(id.slice(1)) - 1042) + '"]');
    await expect(origin).toBeInViewport();
    await expect(origin.locator("p")).toHaveText("1111111111 2222222222 2222222222");
    await demo.getByRole("button", { name: arabic ? "شوفها بالقروب" : "View in group" }).click();
    await expect(demo.locator(".inbox-origin")).toHaveCount(0);
    // Select the shared origin again for the second ticket; later agent replies are separate.
    if (id !== ids.at(-1)) await post("1111111111 2222222222");
  }
  await trigger.click();
  await demo.locator('[name="demo-digits"]').fill("3"); await save.click();
  const historyCount = await demo.locator(".inbox-history-entry").count();
  const tooMany = Array.from({ length: 101 }, (_, index) => String(100 + index)).join(" ");
  await post(tooMany);
  await expect(demo.getByRole("alert")).toContainText("100");
  await expect(demo.locator("#demo-reply")).toHaveValue(tooMany);
  await expect(demo.locator(".inbox-history-entry")).toHaveCount(historyCount);
  await demo.locator("#demo-reply").fill("");
  await demo.locator(".inbox-related-toggle").click();
  await demo.locator(".inbox-related-row").first().focus(); await page.keyboard.press("Escape");
  await expect(demo.locator(".inbox-related-toggle")).toBeFocused();
});

test("related open and closed tickets preserve separate threads and quote targets in the group", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#product");
  const related = demo.locator(".inbox-related-toggle");
  const draft = demo.locator("#demo-reply");
  const send = demo.locator(".inbox-composer button[type=submit]");
  const open = arabic ? "مفتوحة" : "Open";
  const closed = arabic ? "مغلقة" : "Closed";
  const viewGroup = () => demo.getByRole("button", { name: arabic ? "شوفها بالقروب" : "View in group" }).click();
  const closedRow = () => demo.locator(".inbox-related-row").filter({ hasText: "#1046" });
  await related.click();
  await expect(demo.locator(".inbox-related-row")).toHaveCount(2);
  await expect(closedRow()).toContainText(arabic ? "نورة" : "Noura");
  await demo.locator(".inbox-related-filters").getByRole("button", { name: closed, exact: true }).click();
  await expect(demo.locator(".inbox-related-row")).toHaveCount(1);
  await closedRow().click();
  await expect(demo.locator(".inbox-conversation-header")).toContainText("#1046");
  await expect(demo.locator('[name="demo-ticket-status"]')).toHaveValue("closed");
  await expect(demo.locator('[name="demo-ticket-status"]')).toBeVisible();
  await expect(demo.locator(".inbox-messages")).toContainText("9876543210");
  await expect(demo.locator(".inbox-messages")).not.toContainText("1234567890");
  await draft.fill("Closed ticket reply"); await send.click();
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Closed ticket reply");
  await draft.fill("Closed ticket draft");
  await viewGroup();
  await expect(demo.locator(".inbox-messages")).toContainText("Closed ticket reply");
  await demo.locator('.inbox-original .inbox-request-reply').click();
  await draft.fill("Open ticket reply"); await send.click();
  await expect(demo.locator(".inbox-message-outbound").filter({ has: page.locator("p", { hasText: "Open ticket reply" }) }).locator("blockquote")).not.toContainText("Closed ticket reply");
  await demo.getByRole("button", { name: arabic ? "أرسل للقروب فقط" : "Send to group only", exact: true }).click();
  await expect(demo.locator('.inbox-sender-switch button[aria-pressed="true"]')).toHaveText(arabic ? "فريقك" : "Your team");
  await expect(demo.locator(".inbox-composer-context")).toHaveText(arabic ? "رسالة للقروب فقط" : "Group message only");
  await draft.fill("Unrelated group message"); await send.click();
  await demo.locator('[data-origin="4"] .inbox-request-reply').click();
  await expect(draft).toHaveValue("Closed ticket draft");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Closed ticket reply");
  await draft.fill("Closed thread from group"); await send.click();
  await related.click();
  await closedRow().click();
  await expect(demo.locator(".inbox-messages")).toContainText("Closed thread from group");
  await expect(demo.locator(".inbox-messages")).not.toContainText("Open ticket reply");
  await expect(demo.locator(".inbox-messages")).not.toContainText("Unrelated group message");
  await expect(demo.locator('[name="demo-ticket-status"]')).toHaveValue("closed");
  await viewGroup();
  await demo.getByRole("button", { name: arabic ? "شرط التذكرة" : "Trigger", exact: true }).click();
  await demo.locator('[name="demo-digits"]').fill("7");
  await demo.locator(".inbox-trigger-editor button[type=submit]").click();
  await expect(demo.locator(".inbox-messages")).toContainText("Open ticket reply");
  await expect(demo.locator(".inbox-messages")).toContainText("Closed thread from group");
  await expect(demo.locator(".inbox-messages")).toContainText("Unrelated group message");
  await related.click();
  await demo.locator(".inbox-related-filters").getByRole("button", { name: open, exact: true }).click();
  await expect(demo.locator(".inbox-related-row")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("ticket status, status views and multiple email threads stay consistent without retargeting drafts", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#product"), draft = demo.locator("#demo-reply");
  const status = demo.locator('[name="demo-ticket-status"]');
  const header = demo.locator(".inbox-conversation-header");
  const send = demo.locator(".inbox-composer button[type=submit]");
  const tickets = demo.locator(".inbox-views button").nth(1);
  const viewGroup = () => demo.getByRole("button", { name: arabic ? "شوفها بالقروب" : "View in group" }).click();
  await expect(demo.locator(".inbox-origin")).toHaveCount(0);
  await tickets.click();
  const quote = await demo.locator(".inbox-composer blockquote").textContent();
  await draft.fill("Keep my ticket draft");
  await openChooser(page);
  await demo.locator('[data-panel="group"]').click();
  await demo.locator('[name="demo-group-by"]').selectOption("status");
  await expect(demo.locator(".inbox-team-heading")).toHaveText(arabic ? ["مفتوحة", "مغلقة"] : ["Open", "Closed"]);
  await demo.locator('[data-panel="filter"]').click();
  await demo.locator('[name="demo-status-filter"]').selectOption("open");
  await expect(demo.locator('.inbox-row .inbox-ticket-state[data-state="closed"]')).toHaveCount(0);
  await status.selectOption("closed");
  await expect(header).toContainText("#1042");
  await expect(draft).toHaveValue("Keep my ticket draft");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText(quote!);
  await expect(status).toHaveValue("closed");
  await expect(demo.locator('[name="demo-status-filter"]')).toHaveValue("");
  await expect(demo.getByRole("status")).toContainText(arabic ? "فلتر الحالة" : "Status filter cleared");
  await demo.locator('[name="demo-status-filter"]').selectOption("closed");
  await expect(demo.locator('.inbox-row .inbox-ticket-state[data-state="open"]')).toHaveCount(0);
  await expect(demo.locator(".inbox-team-heading")).toHaveText(arabic ? ["مغلقة"] : ["Closed"]);
  await status.selectOption("open");
  await expect(header).toContainText("#1042");
  await expect(draft).toHaveValue("Keep my ticket draft");
  await status.selectOption("closed");
  await viewGroup();
  await expect(demo.locator(".inbox-related-toggle")).toContainText(arabic ? "0 مفتوحة · 2 مغلقة" : "0 Open · 2 Closed");
  await draft.fill("Unrelated note"); await send.click();
  await expect(demo.locator(".inbox-related-toggle")).toContainText(arabic ? "0 مفتوحة" : "0 Open");
  await draft.fill("Any news on 1234567890?"); await send.click();
  await expect(demo.locator(".inbox-related-toggle")).toContainText(arabic ? "1 مفتوحة · 1 مغلقة" : "1 Open · 1 Closed");
  await expect(tickets).toContainText("18");
  await demo.locator(".inbox-history-entry").last().getByRole("button", { name: (arabic ? "تذكرة " : "Ticket ") + "#1042", exact: true }).click();
  await expect(status).toHaveValue("open");
  await expect(draft).toHaveValue("Keep my ticket draft");
  await demo.getByRole("button", { name: arabic ? "شوف الرسالة الأصلية" : "Show original message", exact: true }).click();
  await expect(demo.locator(".inbox-original")).toBeInViewport();
  await expect(demo.locator(".inbox-composer blockquote")).toHaveText("Any news on 1234567890?");
  for (const index of [2, 15, 16, 17]) {
    await openChooser(page);
    await demo.locator(`.inbox-row[value="${index}"]`).click();
    await expect(header).toContainText("#" + (1042 + index));
    await expect(header).toContainText(arabic ? "الإيميل" : "Email");
    await expect(header.locator(".marketing-icon-groups")).toHaveCount(0);
    await expect(demo.locator(".inbox-composer blockquote")).toHaveCount(0);
    await expect(demo.locator(".inbox-messages")).not.toContainText("Email reply ");
    await draft.fill("Email reply " + index); await send.click();
    await draft.fill("Email draft " + index);
    await status.selectOption("closed");
    await expect(draft).toHaveValue("Email draft " + index);
    await expect(status).toHaveValue("closed");
    await status.selectOption("open");
    await expect(demo.locator(".inbox-messages")).toContainText("Email reply " + index);
  }
  await openChooser(page);
  await demo.locator('[data-panel="filter"]').click();
  await demo.locator('[name="demo-status-filter"]').selectOption("closed");
  await demo.locator('[name="demo-team"]').selectOption(arabic ? "العمليات" : "Operations");
  await demo.locator('[name="demo-member"]').selectOption(arabic ? "سارة" : "Sara");
  await expect(demo.locator(".inbox-row")).toHaveCount(0);
  await demo.locator(".inbox-empty-detail button").click();
  await expect(demo.locator('[name="demo-status-filter"]')).toHaveValue("");
  await expect(demo.locator(".inbox-row")).toHaveCount(18);
  await demo.locator('.inbox-row[value="17"]').click();
  await expect(draft).toHaveValue("Email draft 17");
  if ((await page.viewportSize())!.width < 681) expect(await status.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include("#product").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("every sample group and ticket shows its own conversation and latest reply target", async ({ page }) => {
  const state = createDemoWorkspace(createTranslator(arabic ? arabicMarketingMessages : englishMarketingMessages));
  await page.goto("/");
  const demo = page.locator("#product"), thread = demo.locator(".inbox-messages"), draft = demo.locator("#demo-reply");
  for (let group = 0; group < state.groups.length; group++) {
    await openChooser(page);
    await demo.locator(`.inbox-row[value="${group}"]`).click();
    await expect(thread.locator(".inbox-bubble > p")).toHaveText(state.history.filter(message => message.group === group).map(message => message.text));
    await demo.locator(".inbox-related-toggle").click();
    const related = state.tickets.filter(ticket => ticket.group === group);
    await expect(demo.locator(".inbox-related-row strong")).toHaveCount(related.length);
    for (const ticket of related) await expect(demo.locator(".inbox-related-panel")).toContainText(ticket.title);
  }
  await demo.locator(".inbox-views button").nth(1).click();
  await openChooser(page);
  await demo.locator('[data-panel="group"]').click();
  await demo.locator('[name="demo-group-by"]').selectOption("");
  const recent = state.tickets.map((_, index) => ({ index, time: state.history.filter(message => message.tickets.includes(index)).at(-1)!.time })).sort((a, b) => b.time.localeCompare(a.time));
  expect(await demo.locator(".inbox-row").evaluateAll(rows => rows.map(row => row.getAttribute("value")))).toEqual(recent.map(ticket => String(ticket.index)));
  for (let index = 0; index < state.tickets.length; index++) {
    const ticket = state.tickets[index], messages = state.history.filter(message => message.tickets.includes(index));
    await openChooser(page);
    await demo.locator(`.inbox-row[value="${index}"]`).click();
    await expect(demo.locator(".inbox-active-title")).toContainText(ticket.title);
    await expect(demo.locator(".inbox-assignment")).toContainText(`${ticket.owner} · ${ticket.team}`);
    await expect(demo.locator('[name="demo-ticket-status"]')).toHaveValue(ticket.status);
    await expect(thread.locator(".inbox-bubble > p")).toHaveText(messages.map(message => message.text));
    if (ticket.group !== null) {
      await expect(demo.locator(".inbox-sender-name")).toHaveText(ticket.owner);
      await expect(demo.locator('.inbox-sender-switch button[aria-pressed="true"]')).toHaveText(arabic ? "فريقك" : "Your team");
    } else await expect(demo.locator(".inbox-composer-context")).toContainText(`${ticket.owner} · ${arabic ? "فريقك" : "Your team"}`);
    await expect(thread.locator(".inbox-author-role")).toHaveText(messages.map(message => message.author === (arabic ? arabicMarketingMessages : englishMarketingMessages)["marketing.channels.bot"] ? (arabic ? "البوت" : "Bot") : message.outbound ? (arabic ? "فريقك" : "Your team") : (arabic ? "العميل" : "Customer")));
    await expect(thread.locator(".inbox-trigger-label")).toHaveCount(ticket.group === null ? 0 : 1);
    if (ticket.group !== null) {
      await expect(demo.locator(".inbox-composer blockquote")).toHaveText(messages.at(-1)!.text);
      if (ticket.status === "open") {
        const reply = `Follow-up for ${ticket.reference}`;
        await draft.fill(reply); await demo.locator('.inbox-composer button[type="submit"]').click();
        await expect(thread.locator(".inbox-message-outbound").last().locator("blockquote span")).toHaveText(messages.at(-1)!.text);
        await demo.getByRole("button", { name: arabic ? "شوفها بالقروب" : "View in group", exact: true }).click();
        await expect(thread.locator(".inbox-bubble > p").last()).toHaveText(reply);
        await demo.locator(".inbox-history-entry").last().locator(".inbox-request-reply").click();
        await draft.fill(`Confirmed ${ticket.reference}`); await demo.locator('.inbox-composer button[type="submit"]').click();
        await demo.locator(".inbox-views button").nth(1).click();
        await expect(thread.locator(".inbox-bubble > p").last()).toHaveText(`Confirmed ${ticket.reference}`);
        await expect(thread.locator(".inbox-message-outbound").last().locator("blockquote span")).toHaveText(reply);
      }
    } else await expect(demo.locator(".inbox-composer blockquote")).toHaveCount(0);
  }
});

test("visitors switch between customer requests and team replies without mixing drafts or threads", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#product"), draft = demo.locator("#demo-reply"), send = demo.locator('.inbox-composer button[type="submit"]');
  const customer = demo.locator(".inbox-sender-switch").getByRole("button", { name: arabic ? "العميل" : "Customer", exact: true });
  const staff = demo.locator(".inbox-sender-switch").getByRole("button", { name: arabic ? "فريقك" : "Your team", exact: true });
  await demo.locator(".inbox-views button").nth(1).click();
  await draft.fill("Original ticket draft");
  await customer.focus(); await page.keyboard.press("Enter");
  await expect(demo).toHaveAttribute("data-view", "groups");
  await expect(demo).toHaveAttribute("data-running", "false");
  await expect(draft).toBeFocused();
  await expect(customer).toHaveAttribute("aria-pressed", "true");
  await expect(demo.locator(".inbox-composer-context")).toContainText("10");
  await draft.fill("Customer request 1111111111");
  await staff.click();
  await expect(draft).toHaveValue("");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveCount(0);
  await expect(demo.locator(".inbox-composer-context")).toHaveText(arabic ? "رسالة للقروب فقط" : "Group message only");
  await expect(demo.locator(".inbox-sender-name")).toHaveText(arabic ? "فهد" : "Fahad");
  await draft.fill("Team note 5555555555 9876543210");
  await customer.click(); await expect(draft).toHaveValue("Customer request 1111111111");
  await staff.click(); await expect(draft).toHaveValue("Team note 5555555555 9876543210");
  await send.click();
  await expect(demo.locator(".inbox-history-entry").last().locator(".inbox-message-outbound")).toHaveCount(1);
  await expect(demo.locator(".inbox-history-entry").last().locator("mark, .inbox-trigger, blockquote")).toHaveCount(0);
  await expect(demo.locator(".inbox-related-toggle")).toContainText(arabic ? "1 مغلقة" : "1 Closed");
  await expect(demo.locator(".inbox-views button").nth(1)).toContainText("18");
  await demo.locator(".inbox-original .inbox-request-reply").click();
  await expect(draft).toHaveValue("Original ticket draft");
  await expect(demo.locator(".inbox-composer blockquote")).not.toContainText("Team note");
  await customer.click(); await send.click();
  await expect(demo.locator(".inbox-history-entry").last().locator("mark")).toHaveText("1111111111");
  await expect(demo.locator(".inbox-views button").nth(1)).toContainText("19");
  await demo.locator(".inbox-history-entry").last().locator(".inbox-trigger button").first().click();
  await expect(demo.locator(".inbox-conversation-header")).toContainText("#1060");
  await expect(staff).toHaveAttribute("aria-pressed", "true");
  await draft.fill("Your request is being checked."); await send.click();
  await expect(demo.locator(".inbox-message-outbound blockquote span")).toHaveText("Customer request 1111111111");
  await customer.click();
  await expect(demo.locator(".inbox-messages")).toContainText("Your request is being checked.");
  await expect(draft).toHaveValue("");
  await openChooser(page); await demo.locator('.inbox-row[value="1"]').click();
  await staff.click(); await expect(demo.locator(".inbox-sender-name")).toHaveText(arabic ? "سارة" : "Sara");
  await expect(demo.locator(".inbox-composer blockquote")).toHaveCount(0);
  await demo.locator(".inbox-related-toggle").click(); await demo.locator(".inbox-related-row").first().click();
  await customer.click();
  await expect(demo.locator(".inbox-conversation-header")).toContainText(arabic ? "طلبات المتجر" : "Store orders");
  await expect(demo.locator(".inbox-composer-context")).toContainText("ST- + 4");
  for (const button of [customer, staff]) expect(await button.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  // Moving the pointer off the switch also covers its non-hover contrast state.
  await page.mouse.move(0, 0);
  expect((await new AxeBuilder({ page }).include("#product").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await demo.getByRole("button", { name: arabic ? "شرط التذكرة" : "Trigger", exact: true }).click();
  await demo.locator('[name="demo-rule"]').selectOption("contains");
  await demo.locator('[name="demo-pattern"]').fill("W".repeat(240));
  await demo.locator('.inbox-trigger-editor button[type="submit"]').click();
  const hint = await demo.locator(".inbox-composer-context > span").evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), width: element.getBoundingClientRect().width, container: element.closest(".inbox-composer")!.clientWidth }));
  expect(hint.height).toBeLessThanOrEqual(hint.line * 2 + 1);
  expect(hint.width).toBeLessThan(hint.container);
  expect(await demo.locator(".inbox-composer").evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
  await demo.locator(".inbox-views button").nth(1).click(); await openChooser(page); await demo.locator('.inbox-row[value="2"]').click();
  await expect(demo.locator(".inbox-sender-switch")).toHaveCount(0);
  await draft.fill("Email draft");
  await demo.locator(".inbox-views button").first().click(); await staff.click();
  await demo.locator(".inbox-views button").nth(1).click(); await expect(draft).toHaveValue("Email draft");
  await demo.getByRole("button", { name: arabic ? "من جديد" : "Reset", exact: true }).click();
  await expect(customer).toHaveAttribute("aria-pressed", "true"); await expect(draft).toHaveValue("");
  await expect(demo.locator(".inbox-views button").nth(1)).toContainText("18");
});

test("landing uses bundled language fonts and centers its Riyadh footer", async ({ page }) => {
  const fontRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("NotoSansArabic-Variable.woff2")) fontRequests.push(request.url()); });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".inbox-views button").nth(1).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  for (const selector of ["#contact-title", ".marketing-close p", ".inbox-bubble p", ".inbox-bubble blockquote span", ".inbox-views button", ".inbox-composer textarea", ".inbox-status-control select", ".marketing-flow-action strong", ".inbox-author-role", ".inbox-trigger-label", ".inbox-reply-context strong", ".inbox-composer-context blockquote span", ".inbox-bubble mark", ".inbox-sender-switch button", ".inbox-sender-name"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length, selector).toBeGreaterThan(0);
    expect(fonts.every(font => font.isCustomFont && font.familyName === (arabic ? "Noto Sans Arabic" : "Geist")), JSON.stringify({ selector, fonts })).toBe(true);
  }
  const ticketStatus = page.getByRole("combobox", { name: arabic ? "حالة التذكرة" : "Ticket status", exact: true });
  await ticketStatus.click();
  expect(await ticketStatus.locator("option").evaluateAll(options => options.every(option => getComputedStyle(option).fontFamily === getComputedStyle(option.parentElement!).fontFamily))).toBe(true);
  await page.keyboard.press("Escape");
  const { nodeId: brand } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".marketing-brand" });
  expect((await cdp.send("CSS.getPlatformFontsForNode", { nodeId: brand })).fonts.every(font => font.familyName === "Geist")).toBe(true);
  await cdp.detach();
  expect(fontRequests.length).toBe(arabic ? 1 : 0);
  const footer = page.locator(".marketing-footer");
  await expect(footer).toContainText(arabic ? "صُنع بـ ❤️ في الرياض" : "Built with ❤️ in Riyadh");
  expect(await footer.evaluate(element => {
    const footerBox = element.getBoundingClientRect(), copyBox = element.querySelector(".marketing-footer-copy")!.getBoundingClientRect();
    return Math.abs(copyBox.left + copyBox.width / 2 - footerBox.left - footerBox.width / 2);
  })).toBeLessThan(1);
  if ((await page.viewportSize())!.width < 681) {
    await expect(footer).toHaveCSS("flex-direction", "column");
    await expect(footer).toHaveCSS("text-align", "center");
    const offsets = await footer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.children].map(child => { const box = child.getBoundingClientRect(); return Math.abs(box.left + box.width / 2 - bounds.left - bounds.width / 2); });
    });
    expect(Math.max(...offsets)).toBeLessThan(1);
  }
});

test("landing motion can pause, respects reduced motion and yields to inbox interaction", async ({ page }, testInfo) => {
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
  await page.goto("/");
  await page.locator("#product").scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#product")).toHaveAttribute("data-running", "true");
  await expect(page.locator(".marketing-shell")).toHaveAttribute("data-motion", "on");
  await expect(page.locator('#product')).toHaveAttribute('data-view','groups');
  await expect(page.locator('#product .inbox-original .inbox-trigger')).toHaveAttribute('data-created','false');
  expect(await page.locator('#product .inbox-message-followup').evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  // Step through the inbox's 2.6-second phases before checking the next scene.
  await page.clock.runFor(2600);
  await expect(page.locator('#product .inbox-original .inbox-trigger')).toHaveAttribute('data-created','true');
  await page.clock.runFor(2600);
  await expect(page.locator('#product')).toHaveAttribute('data-view','tickets');
  await expect(page.locator('#product .inbox-message-followup')).toBeVisible();
  await page.clock.runFor(2600);
  await expect(page.locator('#product .inbox-message-outbound blockquote').last()).toContainText(arabic ? 'فيه أي تحديث؟' : 'Any update on this?');
  await page.clock.runFor(2600);
  await expect(page.locator('#product')).toHaveAttribute('data-view','groups');
  await expect(page.locator('#product .inbox-message-outbound blockquote').last()).toContainText(arabic ? 'فيه أي تحديث؟' : 'Any update on this?');
  await page.locator("h1").scrollIntoViewIfNeeded();
  await expect(page.locator(".marketing-caret")).toHaveAttribute("data-running", "true");
  const title = page.locator(".marketing-type-text");
  const advanceHeadline = async (matches: (value: string | null) => boolean) => {
    // Advance the word hold, then step below the 35 ms delete delay as React commits each character.
    for (let elapsed = 0; elapsed < 5000 && !matches(await title.textContent());) {
      const step = elapsed === 0 ? 2200 : 25;
      await page.clock.runFor(step);
      elapsed += step;
    }
  };
  const initial = await title.textContent();
  await advanceHeadline(value => value !== initial);
  await expect(title).not.toHaveText(initial ?? "");
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(arabic ? "كل محادثاتك، في مكان واحد." : "All your conversations. One shared inbox.");
  await page.locator("#product").scrollIntoViewIfNeeded();
  await expect(page.locator("#product")).toHaveAttribute("data-running", "true");
  const toggle = page.getByRole("button", { name: arabic ? "إيقاف الحركة" : "Pause animation", exact: true });
  await toggle.click();
  await expect(page.locator(".marketing-shell")).toHaveAttribute("data-motion", "off");
  const frozen = await page.locator("#inbox-conversation").textContent();
  const frozenTitle = await title.textContent();
  await page.clock.runFor(3000);
  expect(await page.locator("#inbox-conversation").textContent()).toBe(frozen);
  expect(await title.textContent()).toBe(frozenTitle);
  await page.getByRole("button", { name: arabic ? "تشغيل الحركة" : "Play animation", exact: true }).click();
  await page.locator(".inbox-views button").nth(1).click();
  await expect(page.locator("#product")).toHaveAttribute("data-view", "tickets");
  await openChooser(page);
  await page.locator('.inbox-row[value="2"]').click();
  await page.clock.runFor(16);
  await page.locator("#demo-reply").fill("Draft stays while animation stops");
  await page.clock.runFor(6000);
  await expect(page.locator("#demo-reply")).toHaveValue("Draft stays while animation stops");
  await expect(page.locator('.inbox-row[value="2"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator(".inbox-composer button[type=submit]").click();
  await expect(page.getByRole("status")).toHaveText(arabic ? "تم إرسال الرد في المثال" : "Example reply sent");
  await page.locator("#contact").scrollIntoViewIfNeeded();
  await expect(page.locator("#product")).toHaveAttribute("data-running", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".marketing-shell")).toHaveAttribute("data-motion", "off");
  await expect(title).toHaveText(arabic ? "كل محادثاتك،" : "All your conversations.");
  await expect(page.locator(".marketing-motion-toggle")).toBeHidden();
  if (testInfo.project.name === "desktop") {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await page.evaluate(() => window.scrollTo(0, 0));
    const labels = arabic ? ["قروبات واتساب", "بوت واتساب", "الإيميل", "إنستقرام", "إكس", "تيك توك", "سلاك"] : ["WhatsApp groups", "WhatsApp bot", "Email", "Instagram", "X", "TikTok", "Slack"];
    await expect(page.locator(".marketing-caret")).toHaveAttribute("data-running", "true");
    for (const [index, label] of labels.entries()) {
      await advanceHeadline(value => value === label);
      await expect(title).toHaveText(label);
      await expect(title).toHaveAttribute("data-whatsapp", String(index < 2));
      await expect(page.locator(".marketing-type-soon")).toHaveAttribute("data-shown", String(index >= 3));
    }
  }
});

test("public access pages keep safe invitation fallbacks and keyboard navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(".marketing-skip")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  for (const target of ["main", "product", "workflows-title", "contact"]) {
    await page.goto(`/#${target}`);
    const positions = await page.locator(`#${target}`).evaluate(element => {
      const header = document.querySelector(".marketing-header")!.getBoundingClientRect();
      return { headerTop: header.top, headerBottom: header.bottom, targetTop: element.getBoundingClientRect().top };
    });
    expect(positions.headerTop).toBe(0);
    expect(positions.targetTop).toBeGreaterThanOrEqual(positions.headerBottom);
  }
  if (testInfo.project.name === "desktop") {
    await page.locator("html").evaluate(el => { el.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.getByRole("link", { name: arabic ? "كيف يشتغل" : "How it works", exact: true }).click();
    expect(await page.locator("#product").evaluate(element => element.getBoundingClientRect().top - document.querySelector(".marketing-header")!.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(0);
  }
  for (const state of ["expired_or_used", "identity_mismatch", "identity_unverified", "membership_conflict", "authentication_failed", "constructor", "__proto__"]) {
    const response = await page.goto(`/invitations/result?state=${state}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main h1")).toBeVisible();
    const href = state === "expired_or_used" || state === "membership_conflict" ? "/auth/login?return_to=/app" : "/";
    await expect(page.locator("main .wx-button")).toHaveAttribute("href", href);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
  await page.goto("/invitations/accept#token=invalid");
  await expect(page).toHaveURL(/\/invitations\/accept$/u);
  await expect(page.locator("main h1")).toHaveText(arabic ? "رابط الدعوة مو كامل" : "This invitation link is incomplete");
  await page.route("**/api/invitations/accept/start", route => route.fulfill({ status: 503, json: {} }));
  await page.goto(`/invitations/accept#token=${"a".repeat(43)}`);
  await expect(page.locator("main h1")).toHaveText(arabic ? "ما قدرنا نفتح الدعوة الحين" : "We can’t open the invitation right now");
  await expect(page.locator("main button")).toBeEnabled();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.goto("/auth/error?reason=expired");
  await expect(page.locator("main h1")).toHaveText(arabic ? "انتهت صلاحية تسجيل دخولك" : "Your sign-in expired");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
