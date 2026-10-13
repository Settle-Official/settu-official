/**
 * Calendar arithmetic for the app's own date picker. Plain year/month/day
 * numbers throughout (month is 0-based, as in Date) and no time zones: a
 * date of birth is a calendar date, not an instant.
 */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Monday first. */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export interface CalendarDate {
  readonly year: number;
  /** 0-based. */
  readonly month: number;
  readonly day: number;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The month as a Monday-first grid: nulls for the days before the 1st, then
 * 1..n. Trailing blanks are left to the grid's own layout.
 */
export function calendarCells(year: number, month: number): (number | null)[] {
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const leading = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const cells: (number | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth(year, month); day++) cells.push(day);
  return cells;
}

/** YYYY-MM-DD → parts, or null if it isn't a real calendar date. */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function formatIsoDate(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** "12 April 1995", or null when there is no valid date to show. */
export function formatLongDate(value: string): string | null {
  const date = parseIsoDate(value);
  return date ? `${date.day} ${MONTH_NAMES[date.month]} ${date.year}` : null;
}
