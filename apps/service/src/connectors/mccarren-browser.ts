import { DateTime } from "luxon";
import { type Page } from "playwright";
import type { ProbeConfiguration } from "./mccarren-data.ts";

const TIME_ZONE = "America/New_York";
const READY_SAMPLE_COUNT = 3;
const POLL_INTERVAL_MS = 100;
const DATE_FORMATS = [
  "yyyy-MM-dd",
  "MM/dd/yyyy",
  "M/d/yyyy",
  "LLL d, yyyy",
  "LLLL d, yyyy",
];

export interface RenderedSchedule {
  cells: unknown[];
  renderedReserveCount: number;
  loadingFinished: true;
}

export interface FullDaySchedule extends RenderedSchedule {
  coverageStartUtc: string;
  coverageEndUtc: string;
  viewportCount: number;
}

interface BrowserSample {
  selectorsReady: boolean;
  isReady: boolean;
  dateValue: string;
  cells: unknown[];
  renderedReserveCount: number;
}

interface GridViewportSample {
  selectorsReady: boolean;
  isReady: boolean;
  dateValue: string;
  nextDisabled: boolean;
  cells: unknown[];
  renderedReserveCount: number;
  nativeControlCount: number;
  reserveLabelCount: number;
  times: string[];
  courts: { id: number; label: string }[];
  courtTimePairs: string[];
  scroll: {
    top: number;
    left: number;
    maxTop: number;
    maxLeft: number;
    clientHeight: number;
    clientWidth: number;
  };
}

function safeBrowserError(): Error {
  return new Error("Unable to read McCarren rendered schedule");
}

function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = DateTime.fromISO(value, { zone: TIME_ZONE });
  return date.isValid && date.toISODate() === value;
}

function displayedDateMatches(value: string, expectedDate: string): boolean {
  const displayed = value.trim();
  return DATE_FORMATS.some((format) => {
    const parsed = DateTime.fromFormat(displayed, format, {
      zone: TIME_ZONE,
      locale: "en-US",
    });
    return parsed.isValid && parsed.toISODate() === expectedDate;
  });
}

/** Read only rendered Reserve controls after the requested scheduler date is ready. */
export async function readRenderedCells(
  page: Page,
  date: string,
  timeoutMs = 15_000,
): Promise<RenderedSchedule> {
  if (
    !isValidLocalDate(date) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw safeBrowserError();
  }

  const deadline = Date.now() + timeoutMs;
  let consecutiveSamples = 0;
  let previousKey: string | undefined;
  let previousCells: unknown[] = [];
  let previousCount = 0;

  try {
    while (Date.now() < deadline) {
      const sample = await page.evaluate((): BrowserSample => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='scheduler-page']",
        );
        if (!root) {
          return {
            selectorsReady: false,
            isReady: false,
            dateValue: "",
            cells: [],
            renderedReserveCount: 0,
          };
        }

        const nextButton = root.querySelector<HTMLButtonElement>(
          "button[data-testid='scheduler-next-btn']",
        );
        const datePicker = root.querySelector<HTMLInputElement>(
          "input[data-testid='scheduler-date-picker'][placeholder='Select date']",
        );
        if (!nextButton || !datePicker) {
          return {
            selectorsReady: false,
            isReady: false,
            dateValue: "",
            cells: [],
            renderedReserveCount: 0,
          };
        }

        const controls = Array.from(
          root.querySelectorAll<HTMLElement>(
            "[data-testid='reserve-slot-btn']",
          ),
        );
        const cells = controls.map((control) => ({
          start: control.getAttribute("data-slot-start"),
          court: control.getAttribute("data-court-label"),
          label: control.getAttribute("aria-label"),
          testid: control.getAttribute("data-testid"),
          text: (control.textContent ?? "").trim(),
        }));
        const renderedReserveCount = Array.from(
          root.querySelectorAll("*"),
        ).filter(
          (node) =>
            node.textContent?.trim() === "Reserve" &&
            !Array.from(node.children).some(
              (child) => child.textContent?.trim() === "Reserve",
            ),
        ).length;
        const busyCount = root.querySelectorAll("[aria-busy='true']").length;
        return {
          selectorsReady: true,
          isReady: !nextButton.disabled && busyCount === 0,
          dateValue: datePicker.value,
          cells,
          renderedReserveCount,
        };
      });

      if (
        !sample.selectorsReady ||
        !sample.isReady ||
        !displayedDateMatches(sample.dateValue, date)
      ) {
        consecutiveSamples = 0;
        previousKey = undefined;
      } else {
        const key = JSON.stringify({
          dateValue: sample.dateValue,
          cells: sample.cells,
          renderedReserveCount: sample.renderedReserveCount,
        });
        if (key === previousKey) {
          consecutiveSamples += 1;
        } else {
          previousKey = key;
          consecutiveSamples = 1;
        }
        previousCells = sample.cells;
        previousCount = sample.renderedReserveCount;
        if (consecutiveSamples >= READY_SAMPLE_COUNT) {
          return {
            cells: previousCells,
            renderedReserveCount: previousCount,
            loadingFinished: true,
          };
        }
      }

      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, remaining));
      }
    }
  } catch {
    throw safeBrowserError();
  }

  throw safeBrowserError();
}

function gridError(): Error {
  return new Error("Unable to verify full McCarren schedule coverage");
}

function timeLabelsForGrid(config: ProbeConfiguration): string[] {
  const [startHour, startMinute] = config.gridStartTime.split(":").map(Number);
  const [endHour, endMinute] = config.gridEndTime.split(":").map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  if (
    !Number.isInteger(config.minIntervalMinutes) ||
    config.minIntervalMinutes < 1 ||
    config.minIntervalMinutes > 120 ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    end <= start
  ) {
    throw gridError();
  }
  const labels: string[] = [];
  for (let minute = start; minute <= end; minute += config.minIntervalMinutes) {
    const hour = Math.floor(minute / 60);
    const minutePart = minute % 60;
    labels.push(
      `${hour % 12 || 12}:${String(minutePart).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`,
    );
  }
  if (labels.length < 2 || labels.length > 100) throw gridError();
  return labels;
}

function uniqueByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scroll each rendered scheduler viewport and require the configured court and
 * time labels to have been observed before describing a date as complete.
 */
export async function readFullDaySchedule(
  page: Page,
  date: string,
  config: ProbeConfiguration,
  timeoutMs = 30_000,
  options: { allowDisabledNext?: boolean } = {},
): Promise<FullDaySchedule> {
  if (
    !isValidLocalDate(date) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    config.courts.length !== 7
  ) {
    throw gridError();
  }
  const expectedTimes = timeLabelsForGrid(config);
  const expectedTimeSet = new Set(expectedTimes);
  const expectedCourtMap = new Map(
    config.courts.map(({ id, label }) => [id, label]),
  );
  if (expectedCourtMap.size !== 7) throw gridError();

  const startedAt = Date.now();
  const allCells: unknown[] = [];
  const seenTimes = new Set<string>();
  const seenCourts = new Set<number>();
  const seenCourtTimePairs = new Set<string>();
  let viewportCount = 0;
  let yLimit = 0;
  let xLimit = 0;
  let yStep = 1;
  let xStep = 1;
  let previousSampleKey: string | undefined;
  let stableSamples = 0;
  const readSample = async (): Promise<GridViewportSample> =>
    page.evaluate(
      (expected) => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='scheduler-page']",
        );
        const nextButton = root?.querySelector<HTMLButtonElement>(
          "button[data-testid='scheduler-next-btn']",
        );
        const datePicker = root?.querySelector<HTMLInputElement>(
          "input[data-testid='scheduler-date-picker'][placeholder='Select date']",
        );
        if (!root || !nextButton || !datePicker) {
          return {
            selectorsReady: false,
            isReady: false,
            dateValue: "",
            nextDisabled: true,
            cells: [],
            renderedReserveCount: 0,
            nativeControlCount: 0,
            reserveLabelCount: 0,
            times: [],
            courts: [],
            courtTimePairs: [],
            scroll: {
              top: 0,
              left: 0,
              maxTop: 0,
              maxLeft: 0,
              clientHeight: 0,
              clientWidth: 0,
            },
          };
        }

        const isTimeLabel = (element: Element) => {
          const text = (element.textContent ?? "").trim();
          return (
            element.children.length === 0 &&
            /^\d{1,2}:\d{2} (?:AM|PM)$/.test(text) &&
            text.length <= 12
          );
        };
        const verticalCandidates = Array.from(
          root.querySelectorAll<HTMLElement>("*"),
        )
          .filter(
            (element) =>
              element.scrollHeight > element.clientHeight + 2 &&
              element.clientHeight > 0 &&
              Array.from(element.querySelectorAll("*")).some(isTimeLabel),
          )
          .sort(
            (left, right) =>
              right.scrollHeight -
              right.clientHeight -
              (left.scrollHeight - left.clientHeight),
          );
        const vertical = verticalCandidates[0];
        const horizontalCandidates = [
          root,
          ...Array.from(root.querySelectorAll<HTMLElement>("*")),
        ]
          .filter(
            (element) =>
              element.scrollWidth > element.clientWidth + 2 &&
              element.clientWidth > 0 &&
              (element.querySelector("[data-testid='reserve-slot-btn']") !==
                null ||
                element.querySelector(
                  "[data-testid^='scheduler-header-court-name-']",
                ) !== null),
          )
          .sort(
            (left, right) =>
              right.scrollWidth -
              right.clientWidth -
              (left.scrollWidth - left.clientWidth),
          );
        const horizontal = horizontalCandidates[0];
        if (!vertical) {
          return {
            selectorsReady: false,
            isReady: false,
            dateValue: datePicker.value,
            nextDisabled: nextButton.disabled,
            cells: [],
            renderedReserveCount: 0,
            nativeControlCount: 0,
            reserveLabelCount: 0,
            times: [],
            courts: [],
            courtTimePairs: [],
            scroll: {
              top: 0,
              left: 0,
              maxTop: 0,
              maxLeft: 0,
              clientHeight: 0,
              clientWidth: 0,
            },
          };
        }

        const scrollRect = vertical.getBoundingClientRect();
        const horizontalRect =
          horizontal?.getBoundingClientRect() ?? root.getBoundingClientRect();
        const visibleInVertical = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
        };
        const visibleInHorizontal = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.right > horizontalRect.left &&
            rect.left < horizontalRect.right &&
            rect.right > 0 &&
            rect.left < window.innerWidth
          );
        };
        const controls = Array.from(
          root.querySelectorAll<HTMLElement>(
            "[data-testid='reserve-slot-btn']",
          ),
        ).filter(
          (control) =>
            visibleInVertical(control) && visibleInHorizontal(control),
        );
        const cells = controls.map((control) => ({
          start: control.getAttribute("data-slot-start"),
          court: control.getAttribute("data-court-label"),
          label: control.getAttribute("aria-label"),
          testid: control.getAttribute("data-testid"),
          text: (control.textContent ?? "").trim(),
        }));
        const renderedReserveCount = controls.filter(
          (control) => (control.textContent ?? "").trim() === "Reserve",
        ).length;
        const nativeControlCount = controls.length;
        const reserveLabelCount = Array.from(root.querySelectorAll("*")).filter(
          (element) =>
            element.children.length === 0 &&
            (element.textContent ?? "").trim() === "Reserve" &&
            visibleInVertical(element) &&
            visibleInHorizontal(element),
        ).length;
        const timeNodes = Array.from(vertical.querySelectorAll("*")).filter(
          (element) => isTimeLabel(element) && visibleInVertical(element),
        );
        const times = timeNodes.map((element) =>
          (element.textContent ?? "").trim(),
        );
        const courts = expected.courts.flatMap(({ id, label }) => {
          const header = root.querySelector<HTMLElement>(
            `[data-testid='scheduler-header-court-name-${id}']`,
          );
          return header &&
            (header.textContent ?? "").trim() === label &&
            visibleInHorizontal(header)
            ? [{ id, label }]
            : [];
        });
        const busyCount = root.querySelectorAll("[aria-busy='true']").length;
        // Verify actual body cells, not merely the Cartesian product of axis
        // labels. CourtReserve renders relative flex columns with one ordinary
        // background cell per tick, including beneath reservation overlays.
        const bodyColumns = Array.from(
          vertical.querySelectorAll<HTMLElement>("[style]"),
        ).filter(
          (element) =>
            element.style.position === "relative" &&
            element.style.flexGrow === "1" &&
            element.style.flexShrink === "0",
        );
        const courtTimePairs: string[] = [];
        for (const court of courts) {
          const header = root.querySelector<HTMLElement>(
            `[data-testid='scheduler-header-court-name-${court.id}']`,
          )!;
          const headerRect = header.getBoundingClientRect();
          const center = headerRect.left + headerRect.width / 2;
          const columns = bodyColumns.filter((column) => {
            const rect = column.getBoundingClientRect();
            return center > rect.left && center < rect.right;
          });
          if (columns.length !== 1) continue;
          const column = columns[0]!;
          const width = column.getBoundingClientRect().width;
          const rows = Array.from(column.children).filter(
            (child) =>
              !["absolute", "fixed"].includes(getComputedStyle(child).position),
          );
          for (const timeNode of timeNodes) {
            const timeRect = timeNode.getBoundingClientRect();
            const tickHeight =
              timeNodes.length > 1
                ? Math.abs(
                    timeNodes[1]!.getBoundingClientRect().top -
                      timeNodes[0]!.getBoundingClientRect().top,
                  )
                : timeRect.height;
            if (
              rows.some((row) => {
                const rect = row.getBoundingClientRect();
                return (
                  Math.abs(rect.top - timeRect.top) <= 2 &&
                  Math.abs(rect.height - tickHeight) <= 2 &&
                  Math.abs(rect.width - width) <= 2
                );
              })
            )
              courtTimePairs.push(
                `${court.id}\u0000${(timeNode.textContent ?? "").trim()}`,
              );
          }
        }
        let clipTop = Math.max(0, scrollRect.top);
        let clipBottom = Math.min(window.innerHeight, scrollRect.bottom);
        for (
          let ancestor = vertical.parentElement;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          if (
            ["auto", "scroll", "hidden", "clip"].includes(
              getComputedStyle(ancestor).overflowY,
            )
          ) {
            const rect = ancestor.getBoundingClientRect();
            clipTop = Math.max(clipTop, rect.top);
            clipBottom = Math.min(clipBottom, rect.bottom);
          }
        }
        const unclipped =
          clipTop <= scrollRect.top + 2 && clipBottom >= scrollRect.bottom - 2;
        return {
          selectorsReady: true,
          isReady:
            unclipped &&
            busyCount === 0 &&
            (!nextButton.disabled || expected.allowDisabledNext),
          dateValue: datePicker.value,
          nextDisabled: nextButton.disabled,
          cells,
          renderedReserveCount,
          nativeControlCount,
          reserveLabelCount,
          times,
          courts,
          courtTimePairs,
          scroll: {
            top: vertical.scrollTop,
            left: horizontal?.scrollLeft ?? 0,
            maxTop: Math.max(0, vertical.scrollHeight - vertical.clientHeight),
            maxLeft: horizontal
              ? Math.max(0, horizontal.scrollWidth - horizontal.clientWidth)
              : 0,
            clientHeight: vertical.clientHeight,
            clientWidth: horizontal?.clientWidth ?? vertical.clientWidth,
          },
        };
      },
      {
        times: expectedTimes,
        courts: config.courts,
        allowDisabledNext: options.allowDisabledNext === true,
      },
    );

  const setScroll = async (top: number, left: number): Promise<void> => {
    await page.evaluate(
      ({ top, left, expected }) => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='scheduler-page']",
        );
        if (!root) return;
        const isTimeLabel = (element: Element) =>
          element.children.length === 0 &&
          /^\d{1,2}:\d{2} (?:AM|PM)$/.test((element.textContent ?? "").trim());
        const vertical = Array.from(root.querySelectorAll<HTMLElement>("*"))
          .filter(
            (element) =>
              element.scrollHeight > element.clientHeight + 2 &&
              element.clientHeight > 0 &&
              Array.from(element.querySelectorAll("*")).some(isTimeLabel),
          )
          .sort(
            (left, right) =>
              right.scrollHeight -
              right.clientHeight -
              (left.scrollHeight - left.clientHeight),
          )[0];
        const horizontal = [
          root,
          ...Array.from(root.querySelectorAll<HTMLElement>("*")),
        ]
          .filter(
            (element) =>
              element.scrollWidth > element.clientWidth + 2 &&
              element.clientWidth > 0 &&
              (element.querySelector("[data-testid='reserve-slot-btn']") !==
                null ||
                element.querySelector(
                  "[data-testid^='scheduler-header-court-name-']",
                ) !== null),
          )
          .sort(
            (left, right) =>
              right.scrollWidth -
              right.clientWidth -
              (left.scrollWidth - left.clientWidth),
          )[0];
        if (vertical) vertical.scrollTop = top;
        if (horizontal) horizontal.scrollLeft = left;
      },
      { top, left, expected: { times: expectedTimes } },
    );
  };

  try {
    // The Next button is disabled while a date loads, but also on the final
    // posted date. The matching date, zero busy indicators, and three identical
    // samples (including the button state) distinguish those states after the
    // correlated schedule response has arrived. readRenderedCells remains the
    // stricter guard used before any Next-day click.
    let sample: GridViewportSample | undefined;
    let readyKey: string | undefined;
    let readySamples = 0;
    while (readySamples < READY_SAMPLE_COUNT) {
      if (Date.now() - startedAt >= timeoutMs) throw gridError();
      sample = await readSample();
      if (
        !sample.selectorsReady ||
        !sample.isReady ||
        !displayedDateMatches(sample.dateValue, date)
      ) {
        readySamples = 0;
        readyKey = undefined;
      } else {
        const key = JSON.stringify(sample);
        if (key === readyKey) readySamples++;
        else {
          readyKey = key;
          readySamples = 1;
        }
      }
      if (readySamples < READY_SAMPLE_COUNT) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) throw gridError();
        await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, remaining));
      }
    }
    if (!sample) throw gridError();
    yLimit = sample.scroll.maxTop;
    xLimit = sample.scroll.maxLeft;
    yStep = Math.max(1, Math.floor(sample.scroll.clientHeight * 0.72));
    xStep = Math.max(1, Math.floor(sample.scroll.clientWidth * 0.72));
    const positions = (maximum: number, step: number) => {
      const result = [0];
      for (let position = step; position < maximum; position += step) {
        result.push(position);
      }
      if (maximum > 0 && result[result.length - 1] !== maximum) {
        result.push(maximum);
      }
      return result;
    };
    const verticalPositions = positions(yLimit, yStep);
    const horizontalPositions = positions(xLimit, xStep);

    for (const left of horizontalPositions) {
      for (const top of verticalPositions) {
        await setScroll(top, left);
        previousSampleKey = undefined;
        stableSamples = 0;
        while (Date.now() - startedAt < timeoutMs) {
          sample = await readSample();
          if (
            !sample.selectorsReady ||
            !sample.isReady ||
            !displayedDateMatches(sample.dateValue, date)
          ) {
            stableSamples = 0;
            previousSampleKey = undefined;
          } else {
            const key = JSON.stringify(sample);
            if (key === previousSampleKey) stableSamples++;
            else {
              previousSampleKey = key;
              stableSamples = 1;
            }
            if (stableSamples >= READY_SAMPLE_COUNT) break;
          }
          const remaining = timeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, remaining));
        }
        if (stableSamples < READY_SAMPLE_COUNT) throw gridError();
        if (
          sample.renderedReserveCount !== sample.cells.length ||
          sample.nativeControlCount !== sample.cells.length ||
          sample.reserveLabelCount !== sample.cells.length ||
          Math.abs(sample.scroll.maxTop - yLimit) > 2 ||
          Math.abs(sample.scroll.maxLeft - xLimit) > 2 ||
          Math.abs(sample.scroll.top - top) > 2 ||
          Math.abs(sample.scroll.left - left) > 2
        )
          throw gridError();
        sample.times.forEach((time) => seenTimes.add(time));
        sample.courts.forEach(({ id }) => seenCourts.add(id));
        sample.courtTimePairs.forEach((pair) => seenCourtTimePairs.add(pair));
        allCells.push(...sample.cells);
        viewportCount++;
      }
    }

    const expectedCourtIds = new Set(expectedCourtMap.keys());
    if (
      expectedTimes.some((time) => !seenTimes.has(time)) ||
      seenTimes.size !== expectedTimeSet.size ||
      seenCourts.size !== expectedCourtIds.size ||
      [...expectedCourtIds].some((id) => !seenCourts.has(id)) ||
      seenCourtTimePairs.size !==
        expectedCourtIds.size * expectedTimeSet.size ||
      viewportCount !== verticalPositions.length * horizontalPositions.length
    ) {
      throw gridError();
    }

    const cells = uniqueByKey(allCells, (cell) => {
      if (
        typeof cell !== "object" ||
        cell === null ||
        !("court" in cell) ||
        !("start" in cell)
      ) {
        return JSON.stringify(cell);
      }
      return `${String(cell.court)}\u0000${String(cell.start)}`;
    });
    const start = DateTime.fromISO(`${date}T${config.gridStartTime}`, {
      zone: TIME_ZONE,
    });
    const end = DateTime.fromISO(`${date}T${config.gridEndTime}`, {
      zone: TIME_ZONE,
    });
    if (
      !start.isValid ||
      !end.isValid ||
      start.toISODate() !== date ||
      end.toISODate() !== date ||
      start.getPossibleOffsets().length !== 1 ||
      end.getPossibleOffsets().length !== 1
    ) {
      throw gridError();
    }
    return {
      cells,
      renderedReserveCount: cells.length,
      loadingFinished: true,
      coverageStartUtc: start
        .toUTC()
        .toISO({ suppressMilliseconds: true }) as string,
      coverageEndUtc: end
        .toUTC()
        .toISO({ suppressMilliseconds: true }) as string,
      viewportCount,
    };
  } catch {
    throw gridError();
  }
}

/** Stop publication unless the observed schedule replay matched successfully. */
export function requireMatchedReplay(replay: {
  state: string;
  status: number;
}): void {
  if (replay.state !== "matched-browser-response" || replay.status !== 200) {
    throw new Error("McCarren schedule replay did not match");
  }
}
