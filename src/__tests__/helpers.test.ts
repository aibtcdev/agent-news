import { describe, it, expect } from "vitest";
import {
  getPacificDate,
  getPacificYesterday,
  getNextDate,
  getPacificDayStartUTC,
  generateId,
  formatPacificShort,
} from "../lib/helpers";

describe("getPacificDate", () => {
  it("returns a string in YYYY-MM-DD format", () => {
    const result = getPacificDate(new Date("2024-06-15T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses Pacific time (UTC-8 in winter)", () => {
    // 2024-01-01T07:00:00Z = Dec 31, 2023 at 11pm PST (UTC-8)
    const result = getPacificDate(new Date("2024-01-01T07:00:00Z"));
    expect(result).toBe("2023-12-31");
  });

  it("uses current date when no argument given", () => {
    const result = getPacificDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getPacificYesterday", () => {
  it("returns the day before the given date", () => {
    const result = getPacificYesterday(new Date("2024-06-15T20:00:00Z"));
    const today = getPacificDate(new Date("2024-06-15T20:00:00Z"));
    // Just check format, actual value depends on timezone
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Should be one day before today
    expect(new Date(result).getTime()).toBeLessThan(new Date(today).getTime());
  });
});

describe("getNextDate", () => {
  it("advances by exactly one day", () => {
    expect(getNextDate("2024-01-31")).toBe("2024-02-01");
  });

  it("handles month boundaries", () => {
    expect(getNextDate("2024-02-29")).toBe("2024-03-01"); // 2024 is leap year
  });

  it("handles year boundaries", () => {
    expect(getNextDate("2023-12-31")).toBe("2024-01-01");
  });
});

describe("getPacificDayStartUTC", () => {
  it("returns an ISO 8601 UTC string", () => {
    const result = getPacificDayStartUTC("2024-06-15");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns midnight Pacific time (PDT = UTC-7, so 07:00 UTC)", () => {
    // June is PDT (UTC-7), so midnight Pacific = 07:00 UTC
    const result = getPacificDayStartUTC("2024-06-15");
    expect(result).toBe("2024-06-15T07:00:00.000Z");
  });

  it("returns midnight Pacific time (PST = UTC-8, so 08:00 UTC)", () => {
    // January is PST (UTC-8), so midnight Pacific = 08:00 UTC
    const result = getPacificDayStartUTC("2024-01-15");
    expect(result).toBe("2024-01-15T08:00:00.000Z");
  });
});

/**
 * Brief compilation date window tests (issue #183)
 *
 * The daily brief uses a Pacific-aligned date window, not UTC midnight.
 * This prevents signals filed in the late-evening Pacific hours (which fall
 * in the early UTC hours of the following day) from "bleeding" into the
 * next day's brief.
 *
 * The window for a given date YYYY-MM-DD is:
 *   [getPacificDayStartUTC(date), getPacificDayStartUTC(getNextDate(date)))
 *
 * For PST (UTC-8, e.g. January):
 *   2026-01-20 window: 2026-01-20T08:00:00Z <= created_at < 2026-01-21T08:00:00Z
 *
 * A signal at 2026-01-21T05:59Z is 9:59 PM PST on 2026-01-20 — it belongs
 * in the Jan 20 brief, NOT the Jan 21 brief. Without Pacific-aligned windows
 * (i.e., using UTC midnight), this signal would bleed into Jan 21.
 */
describe("brief compilation date window — Pacific timezone boundaries", () => {
  it("window start is midnight Pacific (PST: 08:00 UTC)", () => {
    // January is PST (UTC-8), so midnight Pacific = 08:00 UTC
    const dayStart = getPacificDayStartUTC("2026-01-20");
    expect(dayStart).toBe("2026-01-20T08:00:00.000Z");
  });

  it("window end is midnight Pacific the next day (PST)", () => {
    // Window end = start of the next Pacific day
    const dayEnd = getPacificDayStartUTC(getNextDate("2026-01-20"));
    expect(dayEnd).toBe("2026-01-21T08:00:00.000Z");
  });

  it("window start is midnight Pacific (PDT: 07:00 UTC)", () => {
    // June is PDT (UTC-7), so midnight Pacific = 07:00 UTC
    const dayStart = getPacificDayStartUTC("2026-06-15");
    expect(dayStart).toBe("2026-06-15T07:00:00.000Z");
  });

  it("signal at 5:59 AM UTC day+1 (9:59 PM PST day) is INSIDE the PST window", () => {
    // This is the exact scenario from issue #183 (using January for PST).
    // A signal filed at 2026-01-21T05:59Z is 9:59 PM PST on Jan 20.
    // The Jan 20 brief window is [08:00 Jan 20 UTC, 08:00 Jan 21 UTC).
    // 2026-01-21T05:59Z is within that window → correctly belongs in Jan 20.
    const signalTs = "2026-01-21T05:59:00.000Z";
    const dayStart = getPacificDayStartUTC("2026-01-20");
    const dayEnd = getPacificDayStartUTC(getNextDate("2026-01-20"));

    expect(signalTs >= dayStart).toBe(true);
    expect(signalTs < dayEnd).toBe(true);
  });

  it("signal at 8:01 AM UTC day+1 (12:01 AM PST day+1) is OUTSIDE the PST window", () => {
    // A signal at 2026-01-21T08:01Z is 12:01 AM PST on Jan 21.
    // It should NOT be in the Jan 20 brief — it belongs in Jan 21.
    const signalTs = "2026-01-21T08:01:00.000Z";
    const dayStart = getPacificDayStartUTC("2026-01-20");
    const dayEnd = getPacificDayStartUTC(getNextDate("2026-01-20"));

    expect(signalTs >= dayStart).toBe(true);
    expect(signalTs < dayEnd).toBe(false); // outside the window
  });

  it("signal at exactly midnight Pacific (08:00 UTC) is the first moment of the NEXT day", () => {
    // The window is [start, end) — exclusive upper bound.
    // A signal at exactly 2026-01-21T08:00Z is midnight PST on Jan 21 → Jan 21 brief.
    const signalTs = "2026-01-21T08:00:00.000Z";
    const dayEnd = getPacificDayStartUTC(getNextDate("2026-01-20"));

    // dayEnd == signalTs, so signalTs < dayEnd is false → excluded from Jan 20
    expect(signalTs < dayEnd).toBe(false);
    // And it IS the start of the next day
    expect(signalTs >= getPacificDayStartUTC("2026-01-21")).toBe(true);
  });

  it("with UTC-only windows, late-evening PST signals bleed into the next day", () => {
    // This test documents WHY the Pacific window fix is necessary.
    // If we used UTC midnight instead of Pacific midnight, the window for
    // 2026-01-20 would be [2026-01-20T00:00Z, 2026-01-21T00:00Z).
    //
    // A signal at 2026-01-21T05:59Z would then fall in the UTC window for
    // Jan 21 [2026-01-21T00:00Z, 2026-01-22T00:00Z), meaning signals filed
    // at 9:59 PM PST on Jan 20 would appear in the Jan 21 brief (date bleed).
    const signalTs = "2026-01-21T05:59:00.000Z";

    // UTC-midnight window for Jan 20: [00:00 Jan 20, 00:00 Jan 21)
    const utcEnd = "2026-01-21T00:00:00.000Z";

    // With UTC window, the 5:59 AM UTC signal is OUTSIDE Jan 20 (bleed!)
    expect(signalTs < utcEnd).toBe(false);

    // With Pacific window, the same signal is correctly INSIDE Jan 20
    const pacificStart = getPacificDayStartUTC("2026-01-20");
    const pacificEnd = getPacificDayStartUTC(getNextDate("2026-01-20"));
    expect(signalTs >= pacificStart && signalTs < pacificEnd).toBe(true);
  });
});

describe("generateId", () => {
  it("returns a UUID-like string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // Should be a valid UUID format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateId()));
    expect(ids.size).toBe(10);
  });
});

describe("formatPacificShort", () => {
  it("returns a non-empty string", () => {
    const result = formatPacificShort("2024-06-15T12:00:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the month abbreviation", () => {
    const result = formatPacificShort("2024-06-15T12:00:00Z");
    expect(result).toContain("Jun");
  });
});
