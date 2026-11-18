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
  /** "compact": the 40px admin field size, with the caret inset from the edge. */
  readonly size?: "default" | "compact";
}

// Lists longer than this get a filter box; short ones (chains, currencies)
// don't need one.
const SEARCH_THRESHOLD = 8;

/** The product UI's dropdown: 70px bordered field (54px on a phone), caret. */
export function AppSelect({
  value,
  onChange,
  options,
  placeholder = "Select",
  isLoading = false,
  disabled = false,
  error,
  "aria-label": ariaLabel,
  size = "default",
}: AppSelectProps) {
  const compact = size === "compact";
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
        className={`flex w-full items-center justify-between gap-[10px] text-left font-[family-name:var(--font-sora)] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          compact
            ? "h-[40px] rounded-[14px] pl-[14px] pr-[12px] text-[13px] leading-[18px]"
            : "h-[70px] rounded-[20px] px-[20px] text-[20px] leading-[25px] max-[720px]:h-[54px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[16px] max-[720px]:leading-[20px]"
        } ${
          error ? "text-[#ac4747]" : selected ? "text-white" : "text-[#8d8c8c]"
        }`}
      >
        <span className="truncate">{label}</span>
        <CaretDownIcon
          size={compact ? 16 : 24}
          className={`shrink-0 text-[#a5a2a2] ${compact ? `transition-transform ${open ? "rotate-180" : ""}` : "max-[720px]:size-[20px]"}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-[320px] min-w-[160px] overflow-hidden border border-white/15 bg-[#1e1c1c] shadow-[0_24px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl ${
            compact ? "rounded-[14px]" : "rounded-[20px] max-[720px]:rounded-[14px]"
          }`}
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
                    className={`w-full rounded-[12px] text-left font-[family-name:var(--font-sora)] text-white hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)] ${
                      compact ? "px-[12px] py-[9px] text-[13px]" : "px-[14px] py-[12px] text-[16px]"
                    }`}
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
