import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeCells,
  parseConfiguration,
  parseScheduleQuery,
  parseScheduleSummary,
  type ProbeConfiguration,
} from "./mccarren-data.ts";

const configPayload = {
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
        { Id: 34737, Label: "Court #1 (Singles Court)" },
        { Id: 34738, Label: "Court #2 (Singles Court)" },
      ],
    },
  },
};

const config: ProbeConfiguration = parseConfiguration(configPayload);

function reserveCell(start: string, court = config.courts[0]!.label) {
  const [hour, minute] = start.split(":").map(Number);
  const time = `${hour! % 12 || 12}:${String(minute).padStart(2, "0")} ${hour! < 12 ? "AM" : "PM"}`;
  return {
    start,
    court,
    label: `Reserve ${court} ${time}`,
    testid: "reserve-slot-btn",
    text: "Reserve",
  };
}

function schedulePayload(data: unknown[] = [], total = data.length) {
  return { Data: data, Total: total, Errors: null, AggregateResults: null };
}

describe("McCarren pure payload parsing", () => {
  it("parses a bounded provider configuration while preserving court labels", () => {
    assert.deepEqual(config, {
      organizationId: 10243,
      timeZone: "America/New_York",
      minIntervalMinutes: 30,
      bookingDays: 7,
      gridStartTime: "06:00",
      gridEndTime: "23:59",
      courts: [
        { id: 34737, label: "Court #1 (Singles Court)" },
        { id: 34738, label: "Court #2 (Singles Court)" },
      ],
    });
    assert.equal(
      parseConfiguration({
        ...configPayload,
        Data: {
          Model: {
            ...configPayload.Data.Model,
            Courts: [{ Id: 1, Label: "  Court One  " }],
          },
        },
      }).courts[0]?.label,
      "  Court One  ",
    );
  });

  it("rejects login, wrong-organization, wrong-timezone, and malformed config payloads safely", () => {
    const cases = [
      { Login: true },
      { ...configPayload, IsValid: false },
      {
        ...configPayload,
        Data: { Model: { ...configPayload.Data.Model, OrgId: 5881 } },
      },
      {
        ...configPayload,
        Data: {
          Model: { ...configPayload.Data.Model, TimeZone: "UTC" },
        },
      },
      {
        ...configPayload,
        Data: {
          Model: {
            ...configPayload.Data.Model,
            Courts: [
              { Id: 1, Label: "same" },
              { Id: 2, Label: "same" },
            ],
          },
        },
      },
      {
        ...configPayload,
        Data: {
          Model: {
            ...configPayload.Data.Model,
            Courts: [{ Id: 1, Label: "x".repeat(101) }],
          },
        },
      },
    ];
    for (const payload of cases) {
      assert.throws(
        () => parseConfiguration(payload),
        (error: Error) => {
          assert.equal(error.message, "Invalid McCarren configuration payload");
          assert.doesNotMatch(error.message, /court|5881|token|login/i);
          return true;
        },
      );
    }
  });

  it("accepts only the intended schedule endpoint and a valid NY query date", () => {
    const query = encodeURIComponent(
      JSON.stringify({
        orgId: 10243,
        selectedDate: "2026-10-31",
        timeZone: "America/New_York",
        shortDto: true,
      }),
    );
    assert.deepEqual(
      parseScheduleQuery(
        `https://backend.courtreserve.com/api/scheduler/member-expanded?jsonData=${query}`,
      ),
      { date: "2026-10-31", organizationId: 10243 },
    );

    for (const queryObject of [
      { orgId: 5881, selectedDate: "2026-10-31", timeZone: "America/New_York" },
      {
        orgId: 10243,
        selectedDate: "2026-02-30",
        timeZone: "America/New_York",
      },
      { orgId: 10243, selectedDate: "2026-10-31", timeZone: "UTC" },
    ]) {
      const value = encodeURIComponent(JSON.stringify(queryObject));
      assert.throws(
        () =>
          parseScheduleQuery(
            `https://backend.courtreserve.com/api/scheduler/member-expanded?jsonData=${value}&access_token=private-secret`,
          ),
        (error: Error) => {
          assert.equal(
            error.message,
            "Invalid McCarren schedule query parameters",
          );
          assert.equal(error.message.includes("private-secret"), false);
          return true;
        },
      );
    }
    assert.throws(
      () =>
        parseScheduleQuery(`https://example.test/?access_token=private-secret`),
      (error: Error) => {
        assert.equal(error.message, "Invalid McCarren schedule query URL");
        assert.equal(error.message.includes("private-secret"), false);
        return true;
      },
    );
  });

  it("summarizes complete, partial, and true empty schedules without retaining row details", () => {
    const rows = [
      {
        OrgId: 0,
        Start: "2026-10-31T11:00:00Z",
        End: "2026-10-31T11:30:00+00:00",
        PlayerName: "private player detail",
      },
    ];
    assert.deepEqual(parseScheduleSummary(schedulePayload(rows)), {
      rows: 1,
      total: 1,
      complete: true,
    });
    assert.deepEqual(parseScheduleSummary(schedulePayload(rows, 83)), {
      rows: 1,
      total: 83,
      complete: false,
    });
    assert.deepEqual(parseScheduleSummary(schedulePayload([], 0)), {
      rows: 0,
      total: 0,
      complete: true,
    });
  });

  it("rejects provider errors, login shells, invalid intervals, totals, timestamps, and oversize schedules", () => {
    const invalid = [
      { Login: true },
      { ...schedulePayload(), Errors: ["not authorized"] },
      schedulePayload([], -1),
      schedulePayload(
        [{ Start: "2026-10-31T11:00:00Z", End: "2026-10-31T11:30:00Z" }],
        0,
      ),
      schedulePayload([
        { Start: "2026-10-31T11:00:00", End: "2026-10-31T11:30:00Z" },
      ]),
      schedulePayload([
        { Start: "2026-10-31T11:30:00Z", End: "2026-10-31T11:00:00Z" },
      ]),
      schedulePayload([
        { Start: "2026-02-30T11:00:00Z", End: "2026-02-30T11:30:00Z" },
      ]),
      schedulePayload(
        Array.from({ length: 5001 }, () => ({})),
        5001,
      ),
    ];
    for (const payload of invalid) {
      assert.throws(
        () => parseScheduleSummary(payload),
        (error: Error) => {
          assert.equal(error.message, "Invalid McCarren schedule payload");
          assert.doesNotMatch(
            error.message,
            /private player|not authorized|login/i,
          );
          return true;
        },
      );
    }
  });
});

describe("McCarren native reserve markers", () => {
  it("keeps adjacent court cells separate and does not infer duration", () => {
    const markers = normalizeCells(
      [reserveCell("07:00"), reserveCell("07:30"), reserveCell("07:00")],
      config,
      "2026-10-31",
    );
    assert.deepEqual(
      markers.map(({ localTime, startUtc, bookableDurationMinutes }) => ({
        localTime,
        startUtc,
        bookableDurationMinutes,
      })),
      [
        {
          localTime: "07:00",
          startUtc: "2026-10-31T11:00:00Z",
          bookableDurationMinutes: null,
        },
        {
          localTime: "07:30",
          startUtc: "2026-10-31T11:30:00Z",
          bookableDurationMinutes: null,
        },
      ],
    );
    assert.equal(markers[0]?.kind, "reserve-start-marker");
    assert.equal(markers[0]?.courtId, 34737);
    assert.equal(markers[0]?.gridIntervalMinutes, 30);
  });

  it("uses Luxon New York offsets across the fall DST transition", () => {
    const today = normalizeCells([reserveCell("06:00")], config, "2026-10-31");
    const tomorrow = normalizeCells(
      [reserveCell("06:00")],
      config,
      "2026-11-01",
    );
    assert.equal(today[0]?.startUtc, "2026-10-31T10:00:00Z");
    assert.equal(tomorrow[0]?.startUtc, "2026-11-01T11:00:00Z");
  });

  it("rejects ambiguous and nonexistent DST wall times", () => {
    assert.throws(
      () => normalizeCells([reserveCell("01:30")], config, "2026-11-01"),
      /Invalid McCarren reserve-cell data/,
    );
    assert.throws(
      () => normalizeCells([reserveCell("02:30")], config, "2026-03-08"),
      /Invalid McCarren reserve-cell data/,
    );
  });

  it("rejects unknown courts, invalid times, changed controls, and extra extracted fields", () => {
    const valid = reserveCell("07:00");
    for (const cells of [
      [{ ...valid, court: "Unknown court" }],
      [{ ...valid, start: "25:00" }],
      [{ ...valid, start: "7:00" }],
      [{ ...valid, label: "Reserve Court One 7:00 AM" }],
      [{ ...valid, text: "Booked" }],
      [{ ...valid, playerName: "not retained" }],
    ]) {
      assert.throws(
        () => normalizeCells(cells, config, "2026-10-31"),
        /Invalid McCarren reserve-cell data/,
      );
    }
    assert.throws(
      () => normalizeCells([valid], config, "2026-02-30"),
      /Invalid McCarren local date/,
    );
  });
});
