"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CalendarIcon } from "./icons";
import {
  MONTH_NAMES,
  WEEKDAY_INITIALS,
  calendarCells,
  formatIsoDate,
  formatLongDate,
  parseIsoDate,
} from "@/lib/format/calendar";

interface AppDatePickerProps {
  /** YYYY-MM-DD, or "" when nothing is chosen. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Latest selectable date, YYYY-MM-DD. */
  readonly max: string;
  /** Earliest selectable year. */
  readonly minYear: number;
  readonly placeholder?: string;
  /** The agent card's smaller field. */
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly "aria-label"?: string;
}

type View = "years" | "months" | "days";

const GOLD = "#ecc56f";

/**
 * The product UI's date picker: the same bordered field as AppSelect, with a
 * calendar panel in the app's own style instead of the browser's.
 *
 * Built for dates far in the past (a date of birth): with nothing chosen it
 * opens on the year list, then the months, then the days, so nobody pages
 * back through decades one month at a time. The header steps back out a
 * level, and the arrows move a month at a time once in the day grid.
 */
export function AppDatePicker({
  value,
  onChange,
  max,
  minYear,
  placeholder = "Select date",
  compact = false,
  disabled = false,
  "aria-label": ariaLabel,
}: AppDatePickerProps) {
  const selected = parseIsoDate(value);
  const limit = parseIsoDate(max) ?? { year: new Date().getFullYear(), month: 11, day: 31 };

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("years");
  const [year, setYear] = useState(selected?.year ?? limit.year);
  const [month, setMonth] = useState(selected?.month ?? limit.month);
  const rootRef = useRef<HTMLDivElement>(null);
  const yearListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Bring the current year into view when the year list shows.
  useEffect(() => {
    if (!open || view !== "years") return;
    yearListRef.current
      ?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [open, view]);

  const years = useMemo(() => {
    const list: number[] = [];
    for (let y = limit.year; y >= minYear; y--) list.push(y);
    return list;
  }, [limit.year, minYear]);

  const toggle = () => {
    if (!open) {
      // A chosen date reopens on its own month; an empty field starts with
      // the year, the slowest thing to reach by paging.
      setYear(selected?.year ?? limit.year);
      setMonth(selected?.month ?? limit.month);
      setView(selected ? "days" : "years");
    }
    setOpen((o) => !o);
  };

  const monthAllowed = (y: number, m: number) =>
    y < limit.year || (y === limit.year && m <= limit.month);
  const dayAllowed = (y: number, m: number, d: number) =>
    y < limit.year ||
    (y === limit.year && (m < limit.month || (m === limit.month && d <= limit.day)));

  const stepMonth = (delta: number) => {
    const next = year * 12 + month + delta;
    const nextYear = Math.floor(next / 12);
    const nextMonth = ((next % 12) + 12) % 12;
    if (nextYear < minYear || !monthAllowed(nextYear, nextMonth)) return;
    setYear(nextYear);
    setMonth(nextMonth);
  };
  const canStepBack = year > minYear || month > 0;
  const canStepForward = monthAllowed(
    month === 11 ? year + 1 : year,
    month === 11 ? 0 : month + 1,
  );

  const label = formatLongDate(value);
  const field = compact
    ? "flex h-[48px] w-full items-center justify-between gap-[10px] rounded-[12px] px-[14px] text-left font-[family-name:var(--font-sora)] text-[16px] leading-[20px] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    : "flex h-[70px] w-full items-center justify-between gap-[10px] rounded-[20px] px-[20px] text-left font-[family-name:var(--font-sora)] text-[20px] leading-[25px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 max-[720px]:h-[54px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[16px] max-[720px]:leading-[20px]";
  const cell =
    "flex items-center justify-center rounded-[12px] font-[family-name:var(--font-sora)] text-white transition-[filter] hover:brightness-125 disabled:cursor-not-allowed disabled:text-[#5f5d5d] disabled:hover:brightness-100";
  const chosen = { backgroundColor: GOLD, color: "#111010", fontWeight: 600 } as const;
  const idle = { backgroundColor: "rgba(255,255,255,0.05)" } as const;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        // Inline border: globals.css's unlayered `button { border: 0 }` reset
        // beats any layered border-* utility.
        style={{
          border: `1px solid ${open ? "#d7d6d6" : compact ? "rgba(215,214,214,0.5)" : "rgba(215,214,214,0.7)"}`,
        }}
        className={`${field} ${label ? "text-white" : "text-[#8d8c8c]"}`}
      >
        <span className="truncate">{label ?? placeholder}</span>
        <CalendarIcon
          size={compact ? 18 : 22}
          className={`shrink-0 text-[#a5a2a2] ${compact ? "" : "max-[720px]:size-[20px]"}`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel ?? "Choose a date"}
          className="absolute left-0 top-[calc(100%+8px)] z-30 w-full min-w-[288px] max-w-[calc(100vw-40px)] rounded-[20px] border border-white/15 bg-[#1e1c1c] p-[14px] shadow-[0_24px_48px_rgba(0,0,0,0.5)] max-[720px]:rounded-[14px]"
        >
          <div className="mb-[12px] flex items-center justify-between gap-[8px]">
            {view === "days" ? (
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => stepMonth(-1)}
                disabled={!canStepBack}
                style={idle}
                className="flex size-[44px] items-center justify-center rounded-[12px] text-white hover:brightness-125 disabled:opacity-40"
              >
                <ArrowLeftIcon size={18} />
              </button>
            ) : (
              <span className="size-[44px]" />
            )}

            <button
              type="button"
              // One level out: days → months → years.
              onClick={() => setView(view === "days" ? "months" : "years")}
              disabled={view === "years"}
              className="min-h-[44px] flex-1 rounded-[12px] px-[10px] font-[family-name:var(--font-sora)] text-[16px] font-semibold text-white hover:[background-color:rgba(255,255,255,0.06)] disabled:cursor-default"
            >
              {view === "years"
                ? "Select year"
                : view === "months"
                  ? String(year)
                  : `${MONTH_NAMES[month]} ${year}`}
            </button>

            {view === "days" ? (
              <button
                type="button"
                aria-label="Next month"
                onClick={() => stepMonth(1)}
                disabled={!canStepForward}
                style={idle}
                className="flex size-[44px] items-center justify-center rounded-[12px] text-white hover:brightness-125 disabled:opacity-40"
              >
                <ArrowRightIcon size={18} />
              </button>
            ) : (
              <span className="size-[44px]" />
            )}
          </div>

          {view === "years" && (
            // data-lenis-prevent: Lenis would scroll the page instead of
            // this list (see AppSelect).
            <div
              ref={yearListRef}
              data-lenis-prevent
              className="grid max-h-[252px] grid-cols-4 gap-[6px] overflow-y-auto overscroll-contain pr-[2px]"
            >
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  data-current={y === year}
                  onClick={() => {
                    setYear(y);
                    if (!monthAllowed(y, month)) setMonth(limit.month);
                    setView("months");
                  }}
                  style={y === selected?.year ? chosen : idle}
                  className={`${cell} h-[44px] text-[15px]`}
                >
                  {y}
                </button>
              ))}
            </div>
          )}

          {view === "months" && (
            <div className="grid grid-cols-3 gap-[6px]">
              {MONTH_NAMES.map((name, m) => (
                <button
                  key={name}
                  type="button"
                  disabled={!monthAllowed(year, m)}
                  onClick={() => {
                    setMonth(m);
                    setView("days");
                  }}
                  style={
                    selected && selected.year === year && selected.month === m ? chosen : idle
                  }
                  className={`${cell} h-[48px] text-[15px]`}
                >
                  {name.slice(0, 3)}
                </button>
              ))}
            </div>
          )}

          {view === "days" && (
            <div className="grid grid-cols-7 gap-[4px]">
              {WEEKDAY_INITIALS.map((d, i) => (
                <span
                  key={i}
                  className="flex h-[28px] items-center justify-center font-[family-name:var(--font-sora)] text-[12px] text-[#8d8c8c]"
                >
                  {d}
                </span>
              ))}
              {calendarCells(year, month).map((day, i) =>
                day === null ? (
                  <span key={`blank-${i}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    disabled={!dayAllowed(year, month, day)}
                    onClick={() => {
                      onChange(formatIsoDate(year, month, day));
                      setOpen(false);
                    }}
                    aria-label={`${day} ${MONTH_NAMES[month]} ${year}`}
                    aria-pressed={
                      !!selected &&
                      selected.year === year &&
                      selected.month === month &&
                      selected.day === day
                    }
                    style={
                      selected &&
                      selected.year === year &&
                      selected.month === month &&
                      selected.day === day
                        ? chosen
                        : undefined
                    }
                    className={`${cell} aspect-square min-h-[36px] text-[15px] hover:[background-color:rgba(255,255,255,0.08)]`}
                  >
                    {day}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
