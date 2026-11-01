import { chromium } from "playwright";
import { writePrivateJson } from "../apps/service/src/local-state.ts";
import { saveSession } from "../apps/service/src/connectors/session.ts";
import {
  providerReadPermission,
  persistObservedRateLimit,
} from "../apps/service/src/provider-access.ts";
import { retryAfterSeconds } from "../apps/service/src/connectors/mccarren.ts";
import { observe } from "./diagnostics/response-observation.ts";

const PORTAL = "https://app.courtreserve.com/Online/Portal/Index/10243";
const ZONE = "America/New_York";

class ConnectError extends Error {}

async function connect(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      timezoneId: ZONE,
      viewport: { width: 1440, height: 1000 },
    });
    const network = observe(context);
    const control = await context.newPage();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await control.exposeFunction("finishMcCarren", finish);
    await control.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Save McCarren session</title>
      <h1>McCarren connection</h1><p>In the other tab, sign in to McCarren and open the court schedule.</p>
      <p>Return here and press Save session.</p>
      <button type="button">Save session</button><p id="status" role="status"></p></html>`);
    await control.getByRole("button").evaluate((button) =>
      button.addEventListener("click", () => {
        void (
          window as unknown as { finishMcCarren(): Promise<void> }
        ).finishMcCarren();
        button.setAttribute("disabled", "");
        document.getElementById("status")!.textContent = "Saving session…";
      }),
    );
    const page = await context.newPage();
    const portalResponse = await page.goto(PORTAL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    if (portalResponse?.status() === 429) {
      persistObservedRateLimit({
        observedAt: new Date().toISOString(),
        retryAfterSeconds: retryAfterSeconds(
          portalResponse.headers()["retry-after"],
        ),
      });
      throw new ConnectError(
        "CourtReserve is rate limited; wait for its retry deadline.",
      );
    }
    await page.bringToFront();
    await writePrivateJson("connect-status.json", {
      state: "waiting-for-user",
      startedAt: new Date().toISOString(),
    });
    console.log(
      "Sign in in the McCarren tab, open the schedule, then click Save session in the helper tab.",
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ConnectError("Login timed out. Run make connect again."),
              ),
            20 * 60 * 1000,
          );
          browser.once("disconnected", () =>
            reject(new ConnectError("Login browser closed before saving.")),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await network.finish();
    if (
      !network.state.loggedIn ||
      new URL(page.url()).origin !== "https://app.courtreserve.com" ||
      !/\/10243$/.test(new URL(page.url()).pathname)
    ) {
      throw new ConnectError(
        "McCarren login was not confirmed. Run make connect again.",
      );
    }
    await saveSession(context);
    await writePrivateJson("connect-status.json", {
      state: "session-saved",
      savedAt: new Date().toISOString(),
    });
    console.log(
      "McCarren login confirmed; cookies saved privately. Run make test-live to validate schedule retrieval.",
    );
  } finally {
    await browser.close();
  }
}

try {
  const permission = providerReadPermission();
  if (!permission.allowed) throw new ConnectError(permission.message);
  await connect();
} catch (error) {
  const message =
    error instanceof ConnectError
      ? error.message
      : "McCarren connection failed. Provider data was not accepted; inspect the browser manually.";
  console.error(message);
  process.exitCode = 1;
}
