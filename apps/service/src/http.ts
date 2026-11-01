import Fastify from "fastify";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BOOKING_URL,
  TIME_ZONE,
  PreferencesPatchSchema,
  ScheduleResponseSchema,
  LocalDateSchema,
  dateRange,
  localToday,
} from "../../../packages/contracts/src/index.ts";
import type { ScheduleStore } from "./store.ts";
import type { RefreshScheduler } from "./scheduler.ts";
import { diagnostics } from "./diagnostics.ts";

export interface HttpOptions {
  store: ScheduleStore;
  scheduler: RefreshScheduler;
  port: number;
  webRoot?: string;
  architectureHtml?: string;
  now?: () => number;
}

export async function buildApp(options: HttpOptions) {
  const { store, scheduler, port } = options;
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger: false,
    bodyLimit: 4096,
    requestTimeout: 10000,
  });
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const error = (code: string, message: string) => ({
    error: { code, message },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    reply.header("Cache-Control", "no-store");
    if (
      !hosts.has(request.headers.host ?? "") ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply
        .code(403)
        .send(
          error("FORBIDDEN", "Only local same-origin requests are allowed."),
        );
    }
    if (
      request.headers.origin &&
      request.headers.origin !== `http://${request.headers.host}`
    ) {
      return reply
        .code(403)
        .send(
          error("FORBIDDEN", "Only local same-origin requests are allowed."),
        );
    }
    if (
      ["POST", "PATCH"].includes(request.method) &&
      !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
    ) {
      return reply
        .code(415)
        .send(
          error("UNSUPPORTED_MEDIA_TYPE", "Send an application/json body."),
        );
    }
  });
  app.setErrorHandler((failure, _request, reply) => {
    const status =
      typeof failure === "object" &&
      failure !== null &&
      "statusCode" in failure &&
      typeof failure.statusCode === "number" &&
      failure.statusCode >= 400 &&
      failure.statusCode < 500
        ? failure.statusCode
        : 500;
    return reply
      .code(status)
      .send(
        error(
          status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
          status === 500
            ? "The local service could not complete this request."
            : "The request is not valid.",
        ),
      );
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(error("NOT_FOUND", "This resource does not exist.")),
  );
  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", () => ({
    status: "ok",
    revision: store.revision(),
  }));
  app.get("/health/collection", (_request, reply) => {
    const result = diagnostics(store, scheduler.status(), now(), 1);
    return reply.code(result.collection.isFresh ? 200 : 503).send({
      service: "running",
      collection: result.collection,
      source: result.source,
    });
  });
  app.get("/api/diagnostics", (request, reply) => {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(422)
        .send(
          error(
            "VALIDATION_ERROR",
            "Use a diagnostics history limit from 1 to 100.",
          ),
        );
    return diagnostics(store, scheduler.status(), now(), parsed.data.limit);
  });
  app.get("/api/facilities", () => ({
    facilities: [
      {
        id: "mccarren",
        name: "McCarren Tennis Center",
        borough: "Brooklyn",
        indoor: true,
        surface: null,
        bookingUrl: BOOKING_URL,
      },
    ],
  }));
  app.get("/api/sources", () => ({ sources: [scheduler.status()] }));
  app.get("/api/preferences", () => store.readPreferences());
  app.patch("/api/preferences", (request, reply) => {
    const parsed = PreferencesPatchSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(422)
        .send(error("VALIDATION_ERROR", "Invalid display preferences."));
    return store.updatePreferences(parsed.data);
  });
  const querySchema = z
    .object({
      from: LocalDateSchema.optional(),
      days: z.coerce.number().int().min(1).max(7).default(7),
    })
    .strict();
  app.get("/api/schedule", (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(422)
        .send(
          error(
            "VALIDATION_ERROR",
            "Use a valid New York start date and 1–7 days.",
          ),
        );
    const dates = dateRange(
      parsed.data.from ?? localToday(now()),
      parsed.data.days,
    );
    const source = scheduler.status();
    return ScheduleResponseSchema.parse({
      revision: store.revision(),
      range: { from: dates[0], to: dates.at(-1), timeZone: TIME_ZONE },
      source,
      partitions: store.readPartitions(dates, now(), source.cadenceSeconds * 2),
      preferences: store.readPreferences(),
    });
  });
  app.post("/api/refresh-requests", (request, reply) => {
    if (!z.object({}).strict().safeParse(request.body).success)
      return reply
        .code(422)
        .send(
          error(
            "VALIDATION_ERROR",
            "Refresh requests take an empty JSON object.",
          ),
        );
    return reply.code(202).send(scheduler.requestRefresh());
  });
  if (options.webRoot) {
    // Register only the exact files emitted by Vite. No request-derived paths,
    // wildcard directory traversal, source files, or local session files.
    const index = await readFile(join(options.webRoot, "index.html"));
    app.get("/", (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(index),
    );
    const assetsRoot = join(options.webRoot, "assets");
    for (const file of await readdir(assetsRoot, { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-zA-Z0-9_-]+\.(js|css)$/.test(file.name))
        continue;
      const contents = await readFile(join(assetsRoot, file.name));
      const type = file.name.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8";
      app.get(`/assets/${file.name}`, (_request, reply) =>
        reply.type(type).send(contents),
      );
    }
  }
  if (options.architectureHtml) {
    const architecture = await readFile(options.architectureHtml);
    app.get("/architecture", (_request, reply) =>
      reply
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .type("text/html; charset=utf-8")
        .send(architecture),
    );
  }
  app.addHook("onClose", async () => {
    await scheduler.stop();
    store.close();
  });
  return app;
}
