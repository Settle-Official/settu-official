import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarCells,
  daysInMonth,
  formatIsoDate,
  formatLongDate,
  parseIsoDate,
} from "./calendar";

test("daysInMonth handles leap years", () => {
  assert.equal(daysInMonth(2024, 1), 29);
  assert.equal(daysInMonth(2023, 1), 28);
  assert.equal(daysInMonth(1900, 1), 28); // divisible by 100, not 400
  assert.equal(daysInMonth(2000, 1), 29);
  assert.equal(daysInMonth(2026, 9), 31);
});

test("calendarCells pads a Monday-first grid to the month's first weekday", () => {
  // 1 October 2026 is a Thursday: three blanks (Mon, Tue, Wed) before it.
  const cells = calendarCells(2026, 9);
  assert.deepEqual(cells.slice(0, 5), [null, null, null, 1, 2]);
  assert.equal(cells.filter((c) => c !== null).length, 31);
  // 1 June 2026 is a Monday: no padding.
  assert.equal(calendarCells(2026, 5)[0], 1);
  // 1 November 2026 is a Sunday: six blanks.
  assert.deepEqual(calendarCells(2026, 10).slice(0, 7), [null, null, null, null, null, null, 1]);
});

test("ISO dates round-trip, and bad ones are rejected", () => {
  assert.deepEqual(parseIsoDate("1995-04-12"), { year: 1995, month: 3, day: 12 });
  assert.equal(formatIsoDate(1995, 3, 12), "1995-04-12");
  assert.equal(formatIsoDate(2001, 0, 5), "2001-01-05");
  assert.equal(parseIsoDate(""), null);
  assert.equal(parseIsoDate("1995-02-30"), null);
  assert.equal(parseIsoDate("12/04/1995"), null);
});

test("formatLongDate reads naturally", () => {
  assert.equal(formatLongDate("1995-04-12"), "12 April 1995");
  assert.equal(formatLongDate(""), null);
});
