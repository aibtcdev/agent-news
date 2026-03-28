import { describe, it, expect } from "vitest";
import {
  getUTCDate,
  getUTCYesterday,
  getNextDate,
  getUTCDayStart,
  getUTCDayEnd,
  generateId,
  formatUTCShort,
  toUTCDate,
} from "../lib/helpers";

describe("getUTCDate", () => {
  it("returns a string in YYYY-MM-DD format", () => {
    const result = getUTCDate(new Date("2024-06-15T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns the UTC date (not local time) — early UTC is still same UTC day", () => {
    // 2024-01-01T00:30:00Z is 00:30 UTC on Jan 1 — still Jan 1 UTC
    const result = getUTCDate(new Date("2024-01-01T00:30:00Z"));
    expect(result).toBe("2024-01-01");
  });

  it("returns the UTC date near end of day", () => {
    // 2024-12-31T23:30:00Z is still Dec 31 in UTC
    const result = getUTCDate(new Date("2024-12-31T23:30:00Z"));
    expect(result).toBe("2024-12-31");
  });

  it("uses current date when no argument given", () => {
    const result = getUTCDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getUTCYesterday", () => {
  it("returns the day before the given date in UTC", () => {
    const result = getUTCYesterday(new Date("2024-06-15T20:00:00Z"));
    expect(result).toBe("2024-06-14");
  });

  it("handles month boundaries", () => {
    const result = getUTCYesterday(new Date("2024-03-01T12:00:00Z"));
    expect(result).toBe("2024-02-29"); // 2024 is a leap year
  });

  it("handles year boundaries", () => {
    const result = getUTCYesterday(new Date("2024-01-01T12:00:00Z"));
    expect(result).toBe("2023-12-31");
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

describe("getUTCDayStart", () => {
  it("returns midnight UTC as ISO 8601 string", () => {
    const result = getUTCDayStart("2026-01-20");
    expect(result).toBe("2026-01-20T00:00:00.000Z");
  });

  it("returns an ISO 8601 UTC string", () => {
    const result = getUTCDayStart("2024-06-15");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("always returns T00:00:00.000Z regardless of time of year", () => {
    // No DST complexity — UTC midnight is always T00:00:00.000Z
    expect(getUTCDayStart("2024-06-15")).toBe("2024-06-15T00:00:00.000Z");
    expect(getUTCDayStart("2024-01-15")).toBe("2024-01-15T00:00:00.000Z");
  });
});

describe("getUTCDayEnd", () => {
  it("returns midnight UTC of the next day", () => {
    const result = getUTCDayEnd("2026-01-20");
    expect(result).toBe("2026-01-21T00:00:00.000Z");
  });

  it("handles month boundaries", () => {
    expect(getUTCDayEnd("2024-01-31")).toBe("2024-02-01T00:00:00.000Z");
  });
});

/**
 * UTC midnight boundary tests
 *
 * The daily brief uses UTC-aligned date windows: [getUTCDayStart(date), getUTCDayEnd(date))
 *
 * For 2026-01-20: window is [2026-01-20T00:00:00Z, 2026-01-21T00:00:00Z)
 */
describe("UTC midnight boundaries", () => {
  it("window start is midnight UTC (T00:00:00.000Z)", () => {
    const dayStart = getUTCDayStart("2026-01-20");
    expect(dayStart).toBe("2026-01-20T00:00:00.000Z");
  });

  it("window end is midnight UTC the next day", () => {
    const dayEnd = getUTCDayEnd("2026-01-20");
    expect(dayEnd).toBe("2026-01-21T00:00:00.000Z");
  });

  it("signal at 23:59:59Z is inside the current UTC day", () => {
    const signalTs = "2026-01-20T23:59:59.000Z";
    const dayStart = getUTCDayStart("2026-01-20");
    const dayEnd = getUTCDayEnd("2026-01-20");

    expect(signalTs >= dayStart).toBe(true);
    expect(signalTs < dayEnd).toBe(true);
  });

  it("signal at exactly 00:00:00Z is the first moment of the next day", () => {
    // The window is [start, end) — exclusive upper bound.
    // A signal at exactly 2026-01-21T00:00:00Z is midnight UTC on Jan 21 → Jan 21 brief.
    const signalTs = "2026-01-21T00:00:00.000Z";
    const dayEnd = getUTCDayEnd("2026-01-20");

    // dayEnd == signalTs, so signalTs < dayEnd is false → excluded from Jan 20
    expect(signalTs < dayEnd).toBe(false);
    // And it IS the start of the next day
    expect(signalTs >= getUTCDayStart("2026-01-21")).toBe(true);
  });

  it("signal at 00:00:01Z of the next day is outside the current day window", () => {
    const signalTs = "2026-01-21T00:00:01.000Z";
    const dayStart = getUTCDayStart("2026-01-20");
    const dayEnd = getUTCDayEnd("2026-01-20");

    expect(signalTs >= dayStart).toBe(true);
    expect(signalTs < dayEnd).toBe(false); // outside the window
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

describe("formatUTCShort", () => {
  it("returns a non-empty string", () => {
    const result = formatUTCShort("2024-06-15T12:00:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the month abbreviation", () => {
    const result = formatUTCShort("2024-06-15T12:00:00Z");
    expect(result).toContain("Jun");
  });

  it("includes ' UTC' suffix", () => {
    const result = formatUTCShort("2024-06-15T12:00:00Z");
    expect(result).toContain(" UTC");
  });
});

describe("toUTCDate", () => {
  it("extracts the UTC date from an ISO timestamp", () => {
    const result = toUTCDate("2024-06-15T23:30:00Z");
    expect(result).toBe("2024-06-15");
  });

  it("uses UTC — not local time", () => {
    // 2024-01-01T00:30:00Z is still Jan 1 in UTC
    const result = toUTCDate("2024-01-01T00:30:00Z");
    expect(result).toBe("2024-01-01");
  });

  it("returns a string in YYYY-MM-DD format", () => {
    const result = toUTCDate("2024-06-15T12:00:00Z");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
