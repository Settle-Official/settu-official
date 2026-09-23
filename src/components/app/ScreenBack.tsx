"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ScreenBackValue {
  /** True while a screen wants a back arrow in the shell's title row. */
  readonly active: boolean;
  readonly goBack: () => void;
  /** Pass a handler to claim the arrow, null to release it. */
  readonly publish: (handler: (() => void) | null) => void;
}

const noop = () => {};
const ScreenBackContext = createContext<ScreenBackValue>({
  active: false,
  goBack: noop,
  publish: noop,
});

/**
 * Lets the active screen put a back arrow next to its title in the app
 * shell's phone header. The offramp form is a two-step wizard on phones and
 * the design puts "← Offramp" in that row rather than inside the card, so
 * the arrow has to be raised out of the screen and into the shell.
 *
 * The handler lives in a ref (like WalletBar's) so a screen republishing it
 * every render can't loop; only the boolean drives re-renders.
 */
export function ScreenBackProvider({ children }: { readonly children: ReactNode }) {
  const handler = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(false);

  const publish = useCallback((next: (() => void) | null) => {
    handler.current = next;
    setActive((current) => (current === !!next ? current : !!next));
  }, []);

  const goBack = useCallback(() => handler.current?.(), []);
  const value = useMemo(() => ({ active, goBack, publish }), [active, goBack, publish]);

  return <ScreenBackContext.Provider value={value}>{children}</ScreenBackContext.Provider>;
}

export function useScreenBack() {
  return useContext(ScreenBackContext);
}
