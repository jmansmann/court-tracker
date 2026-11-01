import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext } from "playwright";
import { DateTime } from "luxon";
import { McCarrenConnector } from "./mccarren.ts";
import {
  BOOKING_URL,
  TIME_ZONE,
  dateRange,
  localToday,
  type PartitionResult,
} from "../../../../packages/contracts/src/index.ts";

const courts = Array.from({ length: 7 }, (_, index) => ({
  Id: index + 1,
  Label: `Court #${index + 1}`,
}));

function controlledPage(dates: string[]): string {
  const ticks = Array.from({ length: 36 }, (_, index) =>
    DateTime.fromISO(`${dates[0]}T06:00`, { zone: TIME_ZONE })
      .plus({ minutes: index * 30 })
      .toFormat("h:mm a"),
  );
  const timeLabels = ticks
    .map(
      (time, index) =>
        `<div style="height:46px;position:absolute;top:${index * 46}px;left:0">${time}</div>`,
    )
    .join("");
  const headers = courts
    .map(
      (court, index) =>
        `<span data-testid="scheduler-header-court-name-${court.Id}" style="position:absolute;left:${80 + 160 * index}px;top:0;width:160px">${court.Label}</span>`,
    )
    .join("");
  const body = courts
    .map(
      (court) =>
        `<div style="position:relative;flex:1 0 160px;height:1656px">${ticks.map((_, index) => `<div style="height:46px">${index === 0 ? `<div data-testid="reserve-slot-btn" data-slot-start="06:00" data-court-label="${court.Label}" aria-label="Reserve ${court.Label} 6:00 AM">Reserve</div>` : ""}</div>`).join("")}</div>`,
    )
    .join("");
  return `<!doctype html><main data-testid="scheduler-page"><button data-testid="scheduler-today-btn">Today</button><button data-testid="scheduler-next-btn" aria-label="Next day">Next day</button><input data-testid="scheduler-date-picker" placeholder="Select date"><div id="busy" aria-busy="true"></div><div style="width:1200px;height:900px;overflow:auto"><div style="position:relative;width:1200px;height:1656px">${headers}${timeLabels}<div style="display:flex;margin-left:80px;width:1120px">${body}</div></div></div></main><script>
    const dates=${JSON.stringify(dates)};
    let date=sessionStorage.getItem('fixture-date')||dates[0];
    const next=document.querySelector('[data-testid="scheduler-next-btn"]');
    const today=document.querySelector('[data-testid="scheduler-today-btn"]');
    async function show(selected){
      date=selected;sessionStorage.setItem('fixture-date',date);
      next.disabled=true;today.disabled=true;document.querySelector('#busy').setAttribute('aria-busy','true');
      document.querySelector('input').value=date;
      const query=new URLSearchParams({jsonData:JSON.stringify({orgId:10243,selectedDate:date,timeZone:'America/New_York'})});
      await fetch('https://backend.courtreserve.com/api/scheduler/member-expanded?'+query).then(r=>r.json());
      document.querySelector('#busy').setAttribute('aria-busy','false');next.disabled=date===dates.at(-1);today.disabled=false;
    }
    next.onclick=()=>show(dates[dates.indexOf(date)+1]);today.onclick=()=>show(dates[0]);
    Promise.all([fetch('/Online/Portal/PortalNavigation/10243'),fetch('/Online/Reservations/Bookings/10243')]).then(()=>show(date));
  </script>`;
}

test(
  "connector walks the terminal date and resets a remembered date on the next cycle without real provider access",
  { timeout: 45000 },
  async () => {
    const dates = dateRange(localToday(), 8);
    let todayResets = 0;
    let context: BrowserContext | undefined;
    const connector = new McCarrenConnector({
      headless: true,
      keepOpen: true,
      loadSession: async () => ({ cookies: [], origins: [] }),
      createContext: async (browser) => {
        context = await browser.newContext({
          timezoneId: TIME_ZONE,
          viewport: { width: 1440, height: 1100 },
        });

        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin + url.pathname === BOOKING_URL)
            return route.fulfill({
              contentType: "text/html",
              body: controlledPage(dates),
            });
          if (url.pathname === "/Online/Portal/PortalNavigation/10243")
            return route.fulfill({
              json: {
                isValid: true,
                data: { Member: { IsLoggedIn: true, IsOrgMember: true } },
              },
            });
          if (url.pathname === "/Online/Reservations/Bookings/10243")
            return route.fulfill({
              json: {
                IsValid: true,
                Data: {
                  Model: {
                    OrgId: 10243,
                    TimeZone: TIME_ZONE,
                    StartTimeStringDisplay: `${dates[0]} 06:00:00`,
                    EndTimeStringDisplay: `${dates[0]} 23:59:00`,
                    MinInterval: 30,
                    DaysACourtCanBeReservedInAdvance: 7,
                    Courts: courts,
                  },
                },
              },
            });
          if (url.pathname === "/api/scheduler/member-expanded") {
            const date = JSON.parse(url.searchParams.get("jsonData")!)
              .selectedDate as string;
            if (date === dates[0]) todayResets++;
            const start = DateTime.fromISO(`${date}T06:00`, {
              zone: TIME_ZONE,
            });
            return route.fulfill({
              headers: { "access-control-allow-origin": "*" },
              json: {
                Data: [
                  {
                    Start: start.toUTC().toISO(),
                    End: start.plus({ hours: 1 }).toUTC().toISO(),
                  },
                ],
                Total: 1,
                Errors: null,
              },
            });
          }
          return route.abort();
        });
        return context;
      },
    });
    try {
      const first: PartitionResult[] = [];
      const summary = await connector.collect({
        from: dates[0]!,
        days: 8,
        onPartition: (partition) => {
          first.push(partition);
        },
      });
      assert.equal(summary.terminalError, undefined);
      assert.equal(summary.completedDates, 8);
      assert.deepEqual(
        first.map((partition) => partition.localDate),
        dates,
      );
      assert.equal(
        first.every(
          (partition) =>
            partition.state === "complete" && partition.openings.length === 7,
        ),
        true,
      );
      assert.equal(
        await context!
          .pages()[0]!
          .getByTestId("scheduler-next-btn")
          .isDisabled(),
        true,
      );
      const second: PartitionResult[] = [];
      const repeated = await connector.collect({
        from: dates[0]!,
        days: 1,
        onPartition: (partition) => {
          second.push(partition);
        },
      });
      assert.equal(repeated.completedDates, 1);
      assert.equal(repeated.terminalError, undefined);
      assert.equal(second[0]!.localDate, dates[0]);
      assert.equal(
        todayResets,
        2,
        "second cycle must use Today after loading the remembered terminal date",
      );
    } finally {
      await connector.close();
    }
  },
);

test(
  "connector cancellation during browser initialization closes resources and publishes no complete partition",
  { timeout: 10000 },
  async () => {
    const controller = new AbortController();
    const connector = new McCarrenConnector({
      headless: true,
      loadSession: async () => ({ cookies: [], origins: [] }),
      createContext: async (browser) => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return browser.newContext();
      },
    });
    try {
      const partitions: PartitionResult[] = [];
      const summary = await connector.collect({
        from: localToday(),
        days: 1,
        signal: controller.signal,
        onPartition: (partition) => {
          partitions.push(partition);
        },
      });
      assert.equal(summary.completedDates, 0);
      assert.ok(summary.terminalError);
      assert.equal(
        partitions.every((partition) => partition.state === "failed"),
        true,
      );
    } finally {
      await connector.close();
    }
  },
);

test(
  "visible and CORS-hidden 429 responses never publish the rendered Reserve grid as availability",
  { timeout: 20000 },
  async () => {
    for (const mode of ["http", "cors"] as const) {
      const dates = dateRange(localToday(), 8);
      let probes = 0;
      let closed = false;
      const connector = new McCarrenConnector({
        headless: true,
        loadSession: async () => ({ cookies: [], origins: [] }),
        probeFailedRead: async (_context, request) => {
          probes++;
          assert.equal(request.method(), "GET");
          return { status: 429, retryAfterSeconds: 7200 };
        },
        createContext: async (browser) => {
          const context = await browser.newContext({
            timezoneId: TIME_ZONE,
            viewport: { width: 1440, height: 1100 },
          });
          context.on("close", () => {
            closed = true;
          });
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin + url.pathname === BOOKING_URL)
              return route.fulfill({
                contentType: "text/html",
                body: controlledPage(dates),
              });
            if (url.pathname === "/Online/Portal/PortalNavigation/10243")
              return route.fulfill({
                json: {
                  isValid: true,
                  data: { Member: { IsLoggedIn: true, IsOrgMember: true } },
                },
              });
            if (url.pathname === "/Online/Reservations/Bookings/10243")
              return route.fulfill({
                json: {
                  IsValid: true,
                  Data: {
                    Model: {
                      OrgId: 10243,
                      TimeZone: TIME_ZONE,
                      StartTimeStringDisplay: `${dates[0]} 06:00:00`,
                      EndTimeStringDisplay: `${dates[0]} 23:59:00`,
                      MinInterval: 30,
                      DaysACourtCanBeReservedInAdvance: 7,
                      Courts: courts,
                    },
                  },
                },
              });
            if (url.pathname === "/api/scheduler/member-expanded") {
              if (mode === "cors") return route.abort("failed");
              return route.fulfill({
                status: 429,
                headers: {
                  "access-control-allow-origin": "*",
                  "retry-after": "7200",
                },
                json: { Errors: "Controlled rate limit" },
              });
            }
            return route.abort();
          });
          return context;
        },
      });
      try {
        const partitions: PartitionResult[] = [];
        const result = await connector.collect({
          from: dates[0]!,
          days: 1,
          onPartition: (partition) => {
            partitions.push(partition);
          },
        });
        assert.equal(result.terminalError, "rate-limited", mode);
        assert.equal(result.completedDates, 0);
        assert.equal(result.retryAfterSeconds, 7200);
        assert.equal(result.diagnostic?.httpStatus, 429);
        assert.equal(result.diagnostic?.endpoint, "schedule-data");
        assert.equal(
          probes,
          mode === "cors" ? 1 : 0,
          "only one diagnostic GET is allowed for the hidden response",
        );
        assert.equal(
          partitions.every(
            (partition) =>
              partition.state === "failed" &&
              partition.diagnostic?.httpStatus === 429,
          ),
          true,
        );
        assert.equal(
          closed,
          true,
          "provider context must close after the failure, preventing idle requests",
        );
      } finally {
        await connector.close();
      }
    }
  },
);
