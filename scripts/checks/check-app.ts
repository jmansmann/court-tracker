import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  BOOKING_URL,
  PreferencesSchema,
  ScheduleResponseSchema,
  type Preferences,
} from "../../packages/contracts/src/index.ts";

const base = "http://127.0.0.1:4317";
const startupDeadline = Date.now() + 30000;
let savedPreferences: Preferences;
while (true) {
  try {
    savedPreferences = PreferencesSchema.parse(
      await (await fetch(`${base}/api/preferences`)).json(),
    );
    break;
  } catch {
    if (Date.now() >= startupDeadline)
      throw new Error("The local app did not become ready on port 4317.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
const browser = await chromium.launch();
const errors: string[] = [];
try {
  const deadline = Date.now() + 90000;
  while (true) {
    const data = ScheduleResponseSchema.parse(
      await (await fetch(`${base}/api/schedule`)).json(),
    );
    if (
      data.source.health === "healthy" &&
      data.partitions.every(
        (partition) => partition.coverage === "complete" && !partition.isStale,
      )
    )
      break;
    if (Date.now() >= deadline)
      throw new Error("The app did not obtain a fresh complete McCarren week.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ view: "week", durationMinutes: null, courtIds: [] }),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(base);
  await page
    .getByRole("table", { name: "Week view of McCarren court starts" })
    .waitFor();
  const response = ScheduleResponseSchema.parse(
    await (await fetch(`${base}/api/schedule`)).json(),
  );
  assert.equal(response.partitions.length, 7);
  assert.equal(
    response.partitions.every((partition) => partition.coverage === "complete"),
    true,
  );
  assert.equal(
    response.source.health === "healthy" || response.source.isRefreshing,
    true,
  );
  const expected = response.partitions.reduce(
    (count, partition) => count + partition.openings.length,
    0,
  );
  assert.equal(
    await page
      .locator(".calendar-grid .opening-marker")
      .evaluateAll((nodes) =>
        nodes.reduce(
          (count, node) =>
            count + Number(node.getAttribute("data-choice-count") ?? "1"),
          0,
        ),
      ),
    expected,
  );
  if (process.env.APP_SCREENSHOT_PATH)
    await page.screenshot({
      path: process.env.APP_SCREENSHOT_PATH,
      fullPage: true,
    });
  await page.locator(".calendar-grid .opening-marker").first().click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  assert.equal(
    await page
      .getByRole("link", { name: "Open McCarren booking site in a new tab" })
      .getAttribute("href"),
    BOOKING_URL,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await page
    .getByRole("table", { name: "Day view of McCarren court starts" })
    .waitFor();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".mobile-list").isVisible(), true);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        state: "live-app-browser-verified",
        openings: expected,
        dates: response.partitions.map((partition) => ({
          date: partition.localDate,
          openings: partition.openings.length,
        })),
        errors,
        screenshot: process.env.APP_SCREENSHOT_PATH ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(savedPreferences),
  });
}
