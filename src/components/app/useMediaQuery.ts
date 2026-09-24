"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query from React.
 *
 * The server snapshot is always `false`: a media query has no meaningful
 * value during SSR, and guessing one only trades a correct second paint for
 * a hydration mismatch. So the first paint is the desktop branch and the
 * phone branch appears on hydration — fine here, because every screen that
 * uses this also carries the real `max-[720px]:` CSS for its styling and
 * only reaches for the hook where the *structure* differs (e.g. splitting a
 * long form into steps), which is not visible before hydration anyway.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The app's phone breakpoint — matches the `max-[720px]:` utilities. */
export const PHONE_QUERY = "(max-width: 720px)";
