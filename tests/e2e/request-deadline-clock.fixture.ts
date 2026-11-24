import { expect, type Page } from "@playwright/test";

type DeadlineWindow = Window & { longestRequestDeadlineMs: number };

export async function installRequestDeadlineClock(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const deadlineWindow = window as DeadlineWindow;
    deadlineWindow.longestRequestDeadlineMs = 0;

    // The browser's native AbortSignal.timeout timer is outside Playwright's clock.
    AbortSignal.timeout = (delay) => {
      const controller = new AbortController();
      deadlineWindow.longestRequestDeadlineMs = Math.max(deadlineWindow.longestRequestDeadlineMs, delay);
      setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), delay);
      return controller.signal;
    };
  });

  return async () => {
    const delay = await page.evaluate(() => (window as DeadlineWindow).longestRequestDeadlineMs);
    expect(delay, "the page must schedule a request deadline").toBeGreaterThan(0);
    await page.clock.fastForward(delay + 1);
  };
}
