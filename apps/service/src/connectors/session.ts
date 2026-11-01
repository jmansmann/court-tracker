import type { BrowserContext, Cookie } from "playwright";
import { readPrivateJson, writePrivateJson } from "../local-state.ts";

class McCarrenSessionError extends Error {}

function isCourtReserveCookie(cookie: Cookie): boolean {
  return /(^|\.)courtreserve\.com$/.test(cookie.domain.replace(/^\./, ""));
}

function invalidSession(): McCarrenSessionError {
  return new McCarrenSessionError(
    "Invalid saved session. Reconnect with make connect.",
  );
}

/** Read protected provider state through the project's symlink-safe local store. */
export async function loadSession(): Promise<{
  cookies: Cookie[];
  origins: [];
}> {
  let state: unknown;
  try {
    state = await readPrivateJson("session.json");
  } catch {
    throw new McCarrenSessionError(
      "Unable to load saved McCarren session. Reconnect with make connect.",
    );
  }
  if (state === undefined) {
    throw new McCarrenSessionError(
      "No saved McCarren session. Run make connect first.",
    );
  }
  if (
    typeof state !== "object" ||
    state === null ||
    !("cookies" in state) ||
    !("origins" in state) ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins) ||
    state.origins.length !== 0 ||
    state.cookies.length > 200
  ) {
    throw invalidSession();
  }
  for (const cookie of state.cookies) {
    if (
      typeof cookie !== "object" ||
      cookie === null ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      !isCourtReserveCookie(cookie as Cookie) ||
      typeof cookie.path !== "string" ||
      typeof cookie.expires !== "number" ||
      typeof cookie.httpOnly !== "boolean" ||
      typeof cookie.secure !== "boolean" ||
      !["Strict", "Lax", "None"].includes(cookie.sameSite)
    ) {
      throw invalidSession();
    }
  }
  return { cookies: state.cookies as Cookie[], origins: [] };
}

/** Persist only CourtReserve cookies; localStorage and unrelated origins are excluded. */
export async function saveSession(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  const session = {
    cookies: state.cookies.filter(isCourtReserveCookie),
    origins: [] as [],
  };
  await writePrivateJson("session.json", session);
}
