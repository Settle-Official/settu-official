"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  code: string;
  name: string;
}

export interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: SelectOption[];
  readonly isLoading?: boolean;
  readonly placeholder?: string;
}

// Above this many options the open panel gets a filter box. Below it, the
// list fits on screen and the typeahead below is enough — a search field on a
// two-item "source chain" dropdown is just noise.
const SEARCH_THRESHOLD = 8;

export function SelectField({
  label,
  value,
  onChange,
  options,
  isLoading,
  placeholder = "Select option",
}: Readonly<SelectFieldProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.code === value);

  const showSearch = options.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.name.toLowerCase().includes(q));
  }, [options, query]);

  // Typeahead: accumulate recently typed characters (like a native <select>)
  // and jump to the first option whose name starts with that buffer. Resets
  // after a pause so unrelated keystrokes later don't chain together.
  const searchBufferRef = useRef("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  // Reset the filter whenever the panel closes; focus it whenever it opens.
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }
    if (showSearch) {
      // Next frame — the input has to be mounted first.
      const id = requestAnimationFrame(() => searchInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen, showSearch]);

  const handleTypeahead = (event: React.KeyboardEvent) => {
    if (
      event.key.length !== 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    event.preventDefault();

    const chained = (searchBufferRef.current + event.key).toLowerCase();
    const match =
      options.find((option) => option.name.toLowerCase().startsWith(chained)) ??
      options.find((option) =>
        option.name.toLowerCase().startsWith(event.key.toLowerCase()),
      );

    searchBufferRef.current = match ? chained : event.key.toLowerCase();
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      searchBufferRef.current = "";
    }, 600);

    if (match) {
      onChange(match.code);
      setIsOpen(false);
    }
  };

  const pick = (code: string) => {
    onChange(code);
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="flex flex-col gap-[0.4rem]" ref={containerRef}>
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
      <div
        className={cn(
          "relative h-[46px] border border-[var(--line)] transition-colors",
          !isLoading && "hover:border-[#666]",
        )}
      >
        <button
          type="button"
          disabled={isLoading}
          onClick={() => setIsOpen((prev) => !prev)}
          onKeyDown={handleTypeahead}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          className={cn(
            "flex h-full w-full items-center justify-between bg-transparent px-[0.8rem] text-left text-[0.95rem] outline-none",
            isLoading && "cursor-not-allowed opacity-50",
            !selected && "text-[var(--muted)]",
          )}
        >
          <span className="truncate">
            {isLoading ? "Loading..." : (selected?.name ?? placeholder)}
          </span>
          <svg
            width="12"
            height="8"
            viewBox="0 0 12 8"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={cn(
              "shrink-0 transition-transform",
              isOpen && "rotate-180",
            )}
          >
            <path
              d="M1 1L6 6L11 1"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {isOpen && !isLoading ? (
          <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-20 border border-[var(--line)] bg-[#0a0a0a] shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
            {showSearch ? (
              <div className="border-b border-[var(--line)] p-[0.4rem]">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (filtered.length > 0) pick(filtered[0].code);
                    }
                  }}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  aria-label={`Search ${label.toLowerCase()}`}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-[34px] w-full bg-[#111] px-[0.6rem] text-[0.9rem] text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
                />
              </div>
            ) : null}
            <ul role="listbox" className="max-h-[220px] overflow-y-auto">
              {filtered.length === 0 ? (
                <li className="px-[0.8rem] py-[0.55rem] text-[0.85rem] text-[var(--muted)]">
                  {options.length === 0
                    ? "No options available"
                    : "No matches"}
                </li>
              ) : (
                filtered.map((option) => (
                  <li
                    key={option.code}
                    role="option"
                    aria-selected={option.code === value}
                  >
                    <button
                      type="button"
                      onClick={() => pick(option.code)}
                      className={cn(
                        "block w-full px-[0.8rem] py-[0.55rem] text-left text-[0.9rem] transition-colors hover:bg-[var(--accent)]/10",
                        option.code === value
                          ? "text-[var(--accent)]"
                          : "text-[var(--foreground)]",
                      )}
                    >
                      {option.name}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
