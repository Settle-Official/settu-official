"use client";

import { useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "settu-theme";

type Theme = "dark" | "light";

/**
 * Small fixed corner control, present on every page via the root layout.
 * The actual `data-theme` attribute is already set before paint by the
 * inline script in layout.tsx (see THEME_INIT_SCRIPT) — this component only
 * needs to read that starting value and handle toggling afterwards.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Nothing to persist — the toggle still works for this page view.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      className="fixed bottom-4 right-4 z-40 border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--foreground)] rounded-none transition-colors hover:bg-[var(--accent)] hover:text-[var(--accent-contrast)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/70"
    >
      {theme === "light" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
