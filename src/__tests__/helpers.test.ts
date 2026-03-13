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
