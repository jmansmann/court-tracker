import { type BrowserContext, type Response } from "playwright";
import { persistObservedRateLimit } from "../../apps/service/src/provider-access.ts";
import { retryAfterSeconds } from "../../apps/service/src/connectors/mccarren.ts";
import {
  parseConfiguration,
  type ProbeConfiguration,
} from "../../apps/service/src/connectors/mccarren-data.ts";

const NAVIGATION =
  "https://app.courtreserve.com/Online/Portal/PortalNavigation/10243";
const CONFIGURATION =
  "https://app.courtreserve.com/Online/Reservations/Bookings/10243";
const SCHEDULE_API =
  "https://backend.courtreserve.com/api/scheduler/member-expanded";

export function endpoint(response: Response): string {
  const url = new URL(response.url());
  return url.origin + url.pathname;
}

/** Observe known provider reads without retaining or printing raw payloads. */
export function observe(context: BrowserContext) {
  const pending = new Set<Promise<void>>();
  const state = {
    loggedIn: false,
    organizationMember: false,
    configuration: undefined as ProbeConfiguration | undefined,
    failure: undefined as string | undefined,
    requests: 0,
  };
  async function capture(response: Response): Promise<void> {
    const url = endpoint(response);
    if (![NAVIGATION, CONFIGURATION, SCHEDULE_API].includes(url)) return;
    state.requests++;
    if (!response.ok()) {
      if (response.status() === 429)
        persistObservedRateLimit({
          observedAt: new Date().toISOString(),
          retryAfterSeconds: retryAfterSeconds(
            response.headers()["retry-after"],
          ),
        });
      state.failure =
        response.status() === 429 ? "rate-limited" : "provider-request-failed";
      return;
    }
    try {
      if (url === NAVIGATION) {
        const payload = await response.json();
        state.loggedIn =
          payload?.isValid === true &&
          payload?.data?.Member?.IsLoggedIn === true;
        state.organizationMember = payload?.data?.Member?.IsOrgMember === true;
      } else if (url === CONFIGURATION) {
        state.configuration = parseConfiguration(await response.json());
      }
    } catch {
      state.failure = "invalid-provider-payload";
    }
  }
  context.on("response", (response) => {
    const task = capture(response).catch(() => {
      state.failure = "provider-read-failed";
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return {
    state,
    async finish() {
      await Promise.all([...pending]);
    },
  };
}
