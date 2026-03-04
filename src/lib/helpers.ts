import { CORS } from "./constants";

export const PACIFIC_TZ = "America/Los_Angeles";

/**
 * Returns the current date in YYYY-MM-DD format in Pacific time
 */
export function getPacificDate(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: PACIFIC_TZ });
}

/**
 * Returns yesterday's date in YYYY-MM-DD format in Pacific time
 */
export function getPacificYesterday(now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return getPacificDate(yesterday);
}

/**
 * Formats an ISO date string to a short Pacific time representation
 * e.g. "Mar 3, 10:30 AM"
 */
export function formatPacificShort(isoStr: string): string {
  return new Date(isoStr).toLocaleString("en-US", {
    timeZone: PACIFIC_TZ,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Generate a unique ID using crypto.randomUUID()
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Return a JSON Response with CORS headers and optional cache and status
 */
export function json(
  data: unknown,
  opts: { status?: number; cache?: number } = {}
): Response {
  const status = opts.status ?? 200;
  const cache = opts.cache ?? 0;
  const headers: Record<string, string> = { ...CORS };
  if (cache > 0) headers["Cache-Control"] = `public, max-age=${cache}`;
  return Response.json(data, { status, headers });
}

/**
 * Return an error JSON Response with CORS headers
 */
export function err(message: string, status = 400, hint?: string): Response {
  const body: Record<string, string> = { error: message };
  if (hint) body.hint = hint;
  return Response.json(body, { status, headers: { ...CORS } });
}

/**
 * Return a CORS preflight response
 */
export function options(): Response {
  return new Response(null, { headers: { ...CORS } });
}

/**
 * Return a 405 Method Not Allowed response
 */
export function methodNotAllowed(): Response {
  return err("Method not allowed", 405);
}
