"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDownIcon } from "./icons";

export interface AppSelectOption {
  readonly code: string;
  readonly name: string;
}

interface AppSelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<AppSelectOption>;
  readonly placeholder?: string;
  readonly isLoading?: boolean;
  readonly disabled?: boolean;
  /** Shown in place of the value, in the design's error red. */
  readonly error?: string | null;
  readonly "aria-label"?: string;
}

// Lists longer than this get a filter box; short ones (chains, currencies)
// don't need one.
const SEARCH_THRESHOLD = 8;

/** The product UI's dropdown: 70px bordered field, 20px radius, caret. */
export function AppSelect({
  value,
  onChange,
  options,
  placeholder = "Select",
  isLoading = false,
  disabled = false,
  error,
  "aria-label": ariaLabel,
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.code === value);
  const showSearch = options.length > SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, query]);

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

  const label = error
    ? error
    : isLoading
      ? "Loading…"
      : selected?.name ?? placeholder;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || isLoading}
        onClick={() => setOpen((o) => !o)}
        // Inline border: globals.css's unlayered `button { border: 0 }` reset
        // beats any layered border-* utility.
        style={{ border: `1px solid ${error ? "#ac4747" : open ? "#d7d6d6" : "rgba(215,214,214,0.7)"}` }}
        className={`flex h-[70px] w-full items-center justify-between gap-[10px] rounded-[20px] px-[20px] text-left font-[family-name:var(--font-sora)] text-[20px] leading-[25px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          error ? "text-[#ac4747]" : selected ? "text-white" : "text-[#8d8c8c]"
        }`}
      >
        <span className="truncate">{label}</span>
        <CaretDownIcon size={24} className="shrink-0 text-[#a5a2a2]" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-[320px] overflow-hidden rounded-[20px] border border-white/15 bg-[#1e1c1c] shadow-[0_24px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        >
          {showSearch && (
            <div className="p-[10px]">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Filter options"
                className="h-[44px] w-full rounded-[12px] border border-white/10 bg-white/5 px-[14px] font-[family-name:var(--font-sora)] text-[16px] text-white outline-none placeholder:text-[#8d8c8c]"
              />
            </div>
          )}
          {/* data-lenis-prevent: Lenis (SmoothScroll) intercepts wheel events
              at the window and would scroll the page instead of this list.
              overscroll-contain stops the browser chaining to the page once
              the list hits its end. */}
          <ul data-lenis-prevent className="max-h-[256px] overflow-y-auto overscroll-contain p-[6px]">
            {visible.length === 0 ? (
              <li className="px-[14px] py-[12px] font-[family-name:var(--font-sora)] text-[16px] text-[#8d8c8c]">
                No matches
              </li>
            ) : (
              visible.map((o) => (
                <li key={o.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.code === value}
                    onClick={() => {
                      onChange(o.code);
                      setOpen(false);
                      setQuery("");
                    }}
                    style={o.code === value ? { backgroundColor: "rgba(201,169,98,0.2)" } : undefined}
                    className="w-full rounded-[12px] px-[14px] py-[12px] text-left font-[family-name:var(--font-sora)] text-[16px] text-white hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)]"
                  >
                    {o.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
