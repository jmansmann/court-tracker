import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  readFullDaySchedule,
  readRenderedCells,
  requireMatchedReplay,
} from "./mccarren-browser.ts";
import {
  parseConfiguration,
  type ProbeConfiguration,
} from "./mccarren-data.ts";

const FIRST_DATE = "2026-10-31";
const NEXT_DATE = "2026-11-01";
const fullDayConfiguration: ProbeConfiguration = parseConfiguration({
  IsValid: true,
  Data: {
    Model: {
      OrgId: 10243,
      TimeZone: "America/New_York",
      StartTimeStringDisplay: "2026-10-31 06:00:00",
      EndTimeStringDisplay: "2026-10-31 23:59:00",
      MinInterval: 30,
      DaysACourtCanBeReservedInAdvance: 7,
      Courts: [
        { Id: 1, Label: "Court #1 (Singles Court)" },
        { Id: 2, Label: "Court #2" },
        { Id: 3, Label: "Court #3" },
        { Id: 4, Label: "Court #4" },
        { Id: 5, Label: "Court #5" },
        { Id: 6, Label: "Court #6" },
        { Id: 7, Label: "Court #7" },
      ],
    },
  },
});
const marker = {
  start: "07:00",
  court: "Court #1",
  label: "Reserve Court #1 7:00 AM",
  testid: "reserve-slot-btn",
  text: "Reserve",
};

let browser: Browser;

function fixture({
  date = FIRST_DATE,
  controls = [marker],
  busy = 0,
  nextDisabled = false,
}: {
  date?: string;
  controls?: (typeof marker)[];
  busy?: number;
  nextDisabled?: boolean;
} = {}): string {
  const busyElements = Array.from(
    { length: busy },
    (_, index) => `<div data-busy="${index}" aria-busy="true"></div>`,
  ).join("");
  const controlElements = controls
    .map(
      (control) =>
        `<button data-testid="${control.testid}" data-slot-start="${control.start}" data-court-label="${control.court}" aria-label="${control.label}">${control.text}</button>`,
    )
    .join("");
  return `<!doctype html><main data-testid="scheduler-page">${busyElements}<button data-testid="scheduler-next-btn" ${nextDisabled ? "disabled" : ""}>Next</button><input data-testid="scheduler-date-picker" placeholder="Select date" value="${date}">${controlElements}</main>`;
}

function fullDayFixture({
  omittedTime,
  omittedCourt,
  controls = true,
  nextDisabled = false,
  omittedBodyCourt,
  clipped = false,
}: {
  omittedTime?: string;
  omittedCourt?: number;
  controls?: boolean;
  nextDisabled?: boolean;
  omittedBodyCourt?: number;
  clipped?: boolean;
} = {}): string {
  const start = 6 * 60;
  const end = 23 * 60 + 59;
  const timeLabels: string[] = [];
  for (let minute = start, row = 0; minute <= end; minute += 30, row++) {
    const hour = Math.floor(minute / 60);
    const label = `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
    if (label === omittedTime) continue;
    timeLabels.push(
      `<span style="position:absolute;top:${row * 46}px;left:0">${label}</span>`,
    );
  }
  const headers = fullDayConfiguration.courts
    .filter(({ id }) => id !== omittedCourt)
    .map(
      ({ id, label }, index) =>
        `<span data-testid="scheduler-header-court-name-${id}" style="position:absolute;top:0;left:${80 + index * 120}px">${label}</span>`,
    )
    .join("");
  const columns = fullDayConfiguration.courts
    .map((court) => {
      const rows =
        court.id === omittedBodyCourt
          ? ""
          : Array.from({ length: 36 }, (_, row) => {
              const marker =
                controls &&
                ((court.id === 1 && row === 0) ||
                  (court.id === 7 && row === 35))
                  ? `<div data-testid="reserve-slot-btn" data-slot-start="${row === 0 ? "06:00" : "23:30"}" data-court-label="${court.label}" aria-label="Reserve ${court.label} ${row === 0 ? "6:00 AM" : "11:30 PM"}">Reserve</div>`
                  : "";
              return `<div style="height:46px">${marker}</div>`;
            }).join("");
      return `<div style="position:relative;flex:1 0 120px;width:120px;height:1656px">${rows}</div>`;
    })
    .join("");
  return `<!doctype html><main data-testid="scheduler-page" style="height:${clipped ? 220 : 500}px;overflow:hidden"><button data-testid="scheduler-next-btn" ${nextDisabled ? "disabled" : ""}>Next</button><input data-testid="scheduler-date-picker" placeholder="Select date" value="${FIRST_DATE}"><div id="grid-viewport" style="width:400px;height:300px;overflow:auto"><div style="position:relative;width:1000px;height:1656px">${headers}${timeLabels.join("")}<div style="display:flex;position:relative;margin-left:80px;width:840px">${columns}</div></div></div></main>`;
}

async function openFixture(page: Page, content: string): Promise<void> {
  await page.setContent(content);
}

describe("McCarren rendered browser readiness", () => {
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser.close();
  });

  it("waits through a delayed date transition with provisional old markers", async () => {
    const page = await browser.newPage();
    try {
      await openFixture(
        page,
        `<!doctype html><main data-testid="scheduler-page"><div aria-busy="true"></div><div aria-busy="true"></div><button data-testid="scheduler-next-btn" disabled>Next</button><input data-testid="scheduler-date-picker" placeholder="Select date" value="${NEXT_DATE}"><button data-testid="reserve-slot-btn" data-slot-start="07:00" data-court-label="Old Court" aria-label="old">Old provisional cell</button></main><script>setTimeout(() => { const root = document.querySelector('[data-testid="scheduler-page"]'); root.querySelectorAll('[aria-busy="true"]').forEach((node) => node.remove()); const next = root.querySelector('[data-testid="scheduler-next-btn"]'); next.disabled = false; root.querySelector('[data-testid="reserve-slot-btn"]').outerHTML = '<button data-testid="reserve-slot-btn" data-slot-start="08:30" data-court-label="Court #2" aria-label="Reserve Court #2 8:30 AM">Reserve</button>'; }, 2300);</script>`,
      );

      const startedAt = Date.now();
      const result = await readRenderedCells(page, NEXT_DATE, 6_000);
      assert.ok(Date.now() - startedAt >= 2_200);
      assert.deepEqual(result, {
        cells: [
          {
            start: "08:30",
            court: "Court #2",
            label: "Reserve Court #2 8:30 AM",
            testid: "reserve-slot-btn",
            text: "Reserve",
          },
        ],
        renderedReserveCount: 1,
        loadingFinished: true,
      });
    } finally {
      await page.close();
    }
  });

  it("accepts identical marker values on a new ready date", async () => {
    const page = await browser.newPage();
    try {
      await openFixture(
        page,
        `<!doctype html><main data-testid="scheduler-page"><div aria-busy="true"></div><div aria-busy="true"></div><button data-testid="scheduler-next-btn" disabled>Next</button><input data-testid="scheduler-date-picker" placeholder="Select date" value="${NEXT_DATE}"><button data-testid="reserve-slot-btn" data-slot-start="07:00" data-court-label="Court #1" aria-label="Reserve Court #1 7:00 AM">Reserve</button><script>setTimeout(() => { const root = document.querySelector('[data-testid="scheduler-page"]'); root.querySelectorAll('[aria-busy="true"]').forEach((node) => node.remove()); root.querySelector('[data-testid="scheduler-next-btn"]').disabled = false; }, 250);</script></main>`,
      );

      const result = await readRenderedCells(page, NEXT_DATE, 2_000);
      assert.deepEqual(result.cells, [marker]);
      assert.equal(result.renderedReserveCount, 1);
      assert.equal(result.loadingFinished, true);
    } finally {
      await page.close();
    }
  });

  it("accepts an empty rendered scope only after the scheduler is ready", async () => {
    const page = await browser.newPage();
    try {
      await openFixture(
        page,
        fixture({
          date: "10/31/2026",
          controls: [],
          busy: 2,
          nextDisabled: true,
        }),
      );
      await page.evaluate(() => {
        setTimeout(() => {
          const root = document.querySelector("[data-testid='scheduler-page']");
          root
            ?.querySelectorAll("[aria-busy='true']")
            .forEach((node) => node.remove());
          const next = root?.querySelector<HTMLButtonElement>(
            "[data-testid='scheduler-next-btn']",
          );
          if (next) next.disabled = false;
        }, 200);
      });

      const result = await readRenderedCells(page, FIRST_DATE, 2_000);
      assert.deepEqual(result.cells, []);
      assert.equal(result.renderedReserveCount, 0);
      assert.equal(result.loadingFinished, true);
    } finally {
      await page.close();
    }
  });

  it("matches each supported date-picker display format in New York", async () => {
    const page = await browser.newPage();
    try {
      for (const displayedDate of [
        NEXT_DATE,
        "11/01/2026",
        "11/1/2026",
        "Nov 1, 2026",
        "November 1, 2026",
      ]) {
        await openFixture(page, fixture({ date: displayedDate, controls: [] }));
        const result = await readRenderedCells(page, NEXT_DATE, 1_000);
        assert.deepEqual(result.cells, [], displayedDate);
      }
    } finally {
      await page.close();
    }
  });

  it("rejects selector drift and invalid local dates with a safe error", async () => {
    const page = await browser.newPage();
    try {
      await openFixture(
        page,
        "<!doctype html><main>unrelated private page text</main>",
      );
      await assert.rejects(
        readRenderedCells(page, FIRST_DATE, 250),
        (error: Error) => {
          assert.equal(
            error.message,
            "Unable to read McCarren rendered schedule",
          );
          assert.equal(error.message.includes("unrelated"), false);
          return true;
        },
      );
      await assert.rejects(
        readRenderedCells(page, "2026-02-30"),
        /Unable to read McCarren rendered schedule/,
      );
    } finally {
      await page.close();
    }
  });
});

describe("McCarren schedule replay gate", () => {
  it("accepts only a matching HTTP 200 browser response replay", () => {
    assert.doesNotThrow(() =>
      requireMatchedReplay({ state: "matched-browser-response", status: 200 }),
    );

    for (const replay of [
      { state: "matched-browser-response", status: 401 },
      { state: "matched-browser-response", status: 403 },
      { state: "matched-browser-response", status: 500 },
      { state: "different-response", status: 200 },
    ]) {
      assert.throws(
        () => requireMatchedReplay(replay),
        (error: Error) =>
          error.message === "McCarren schedule replay did not match",
      );
    }
  });
});

describe("McCarren full-day rendered-grid coverage", () => {
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser.close();
  });

  it("scrolls both axes, deduplicates visible markers, and verifies configured bounds", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await openFixture(page, fullDayFixture());
      const result = await readFullDaySchedule(
        page,
        FIRST_DATE,
        fullDayConfiguration,
      );
      assert.equal(result.viewportCount > 1, true);
      assert.deepEqual(result.cells, [
        {
          start: "06:00",
          court: "Court #1 (Singles Court)",
          label: "Reserve Court #1 (Singles Court) 6:00 AM",
          testid: "reserve-slot-btn",
          text: "Reserve",
        },
        {
          start: "23:30",
          court: "Court #7",
          label: "Reserve Court #7 11:30 PM",
          testid: "reserve-slot-btn",
          text: "Reserve",
        },
      ]);
      assert.equal(result.coverageStartUtc, "2026-10-31T10:00:00Z");
      assert.equal(result.coverageEndUtc, "2026-11-01T03:59:00Z");
      assert.equal(result.renderedReserveCount, 2);
    } finally {
      await page.close();
    }
  });

  it("accepts a true empty schedule only with every configured tick and court header", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await openFixture(page, fullDayFixture({ controls: false }));
      const result = await readFullDaySchedule(
        page,
        FIRST_DATE,
        fullDayConfiguration,
      );
      assert.deepEqual(result.cells, []);
      assert.equal(result.renderedReserveCount, 0);
    } finally {
      await page.close();
    }
  });

  it("rejects missing body content even when both axes and all headers remain", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await openFixture(
        page,
        fullDayFixture({ omittedBodyCourt: 4, controls: false }),
      );
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration, 15000),
        /Unable to verify full McCarren schedule coverage/,
      );
      await openFixture(
        page,
        fullDayFixture({ clipped: true, controls: false }),
      );
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration, 500),
        /Unable to verify full McCarren schedule coverage/,
      );
    } finally {
      await page.close();
    }
  });

  it("accepts a stable terminal date with Next day disabled after full-grid checks", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await openFixture(page, fullDayFixture({ nextDisabled: true }));
      const result = await readFullDaySchedule(
        page,
        FIRST_DATE,
        fullDayConfiguration,
        30_000,
        { allowDisabledNext: true },
      );
      assert.equal(result.renderedReserveCount, 2);
    } finally {
      await page.close();
    }
  });

  it("waits for loading and enabled Next day before measuring a complete grid", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      const delayed = fullDayFixture()
        .replace(
          '<button data-testid="scheduler-next-btn">Next</button>',
          '<div aria-busy="true"></div><button data-testid="scheduler-next-btn" disabled>Next</button>',
        )
        .replace(
          "</main>",
          `</main><script>setTimeout(() => { const root=document.querySelector('[data-testid="scheduler-page"]'); root.querySelector('[aria-busy="true"]').remove(); root.querySelector('[data-testid="scheduler-next-btn"]').disabled=false; }, 300);</script>`,
        );
      await openFixture(page, delayed);
      const started = Date.now();
      const result = await readFullDaySchedule(
        page,
        FIRST_DATE,
        fullDayConfiguration,
      );
      assert.ok(Date.now() - started >= 250);
      assert.equal(result.renderedReserveCount, 2);
    } finally {
      await page.close();
    }
  });

  it("rejects a change in scroll dimensions during viewport traversal", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      const changing = fullDayFixture().replace(
        "</main>",
        `</main><script>document.getElementById('grid-viewport').addEventListener('scroll', () => { document.getElementById('grid-viewport').firstElementChild.style.height='1700px'; }, {once:true});</script>`,
      );
      await openFixture(page, changing);
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration),
        /Unable to verify full McCarren schedule coverage/,
      );
    } finally {
      await page.close();
    }
  });

  it("requires independent Reserve text and native selector counts to agree", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      const extraLabel = fullDayFixture().replace(
        "</div></div></main>",
        "<span>Reserve</span></div></div></main>",
      );
      await openFixture(page, extraLabel);
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration),
        /Unable to verify full McCarren schedule coverage/,
      );
    } finally {
      await page.close();
    }
  });

  it("refuses complete coverage when a configured time row or court is missing", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    try {
      await openFixture(page, fullDayFixture({ omittedTime: "11:00 AM" }));
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration),
        /Unable to verify full McCarren schedule coverage/,
      );
      await openFixture(page, fullDayFixture({ omittedCourt: 7 }));
      await assert.rejects(
        readFullDaySchedule(page, FIRST_DATE, fullDayConfiguration),
        /Unable to verify full McCarren schedule coverage/,
      );
    } finally {
      await page.close();
    }
  });
});
