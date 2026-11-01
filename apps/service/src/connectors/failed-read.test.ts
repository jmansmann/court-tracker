import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Request } from "playwright";
import { confirmFailedScheduleRead } from "./mccarren.ts";
import {
  BOOKING_URL,
  TIME_ZONE,
  localToday,
} from "../../../../packages/contracts/src/index.ts";

test("confirmation replays only a failed validated schedule GET with limited headers and no redirects", async () => {
  const urlFor = (orgId = 10243, timeZone = TIME_ZONE) =>
    `https://backend.courtreserve.com/api/scheduler/member-expanded?${new URLSearchParams({ jsonData: JSON.stringify({ orgId, selectedDate: localToday(), timeZone }) })}`;
  let calls = 0;
  let headerReads = 0;
  let disposed = false;
  const context = {
    request: {
      get: async (
        url: string,
        options: {
          headers: Record<string, string>;
          maxRedirects: number;
          timeout: number;
        },
      ) => {
        calls++;
        assert.equal(url, urlFor());
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.timeout, 10000);
        assert.deepEqual(Object.keys(options.headers).sort(), [
          "accept",
          "authorization",
          "origin",
          "referer",
        ]);
        return {
          status: () => 429,
          headers: () => ({ "retry-after": "61599", server: "cloudflare" }),
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  } as unknown as BrowserContext;
  const requestFor = (url = urlFor(), method = "GET", failed = true) =>
    ({
      url: () => url,
      method: () => method,
      failure: () => (failed ? { errorText: "net::ERR_FAILED" } : null),
      allHeaders: async () => {
        headerReads++;
        return {
          authorization: "controlled-fixture-credential",
          origin: "https://app.courtreserve.com",
          referer: BOOKING_URL,
          accept: "application/json",
          cookie: "controlled-cookie-not-forwarded",
          "x-other": "not-forwarded",
        };
      },
    }) as unknown as Request;
  assert.deepEqual(await confirmFailedScheduleRead(context, requestFor()), {
    status: 429,
    retryAfterSeconds: 61599,
    cloudflareResponse: true,
  });
  assert.equal(disposed, true);
  for (const request of [
    requestFor(urlFor(), "GET", false),
    requestFor(urlFor(), "POST"),
    requestFor(urlFor(5881)),
    requestFor(urlFor(10243, "UTC")),
    requestFor(urlFor().replace("member-expanded", "unverified-operation")),
    requestFor(
      urlFor().replace("backend.courtreserve.com", "untrusted.example"),
    ),
    requestFor(urlFor().replace("https:", "http:")),
  ])
    assert.equal(await confirmFailedScheduleRead(context, request), undefined);
  assert.equal(calls, 1);
  assert.equal(
    headerReads,
    1,
    "invalid or successful reads must not expose headers or issue a replay",
  );
});
