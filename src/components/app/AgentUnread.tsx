"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface AgentUnreadValue {
  readonly count: number;
  readonly publish: (count: number) => void;
}

const AgentUnreadContext = createContext<AgentUnreadValue>({
  count: 0,
  publish: () => {},
});

/**
 * The sidebar's Agent badge, kept outside AgentPanel so it survives
 * navigating away from /app/agent — that route's page (and everything
 * AgentPanel owns: messages, in-flight offramp/onramp state) fully unmounts
 * on route change, same as any other Next.js page. AgentPanel publishes its
 * live unread count in here on every change and deliberately never clears
 * it on unmount, so the badge still shows "you have N unread" while the
 * user is on a different screen.
 *
 * KNOWN LIMITATION: only the *count* survives — the conversation itself
 * does not. Reopening Agent after navigating away starts a fresh chat, so
 * the messages behind that count aren't there to read. Making the actual
 * chat (and any offramp/onramp flow it's narrating) survive navigation
 * would mean lifting that state out of the per-route StellarampDashboard
 * instance into something mounted at this layout level instead — a real
 * architecture change, not a styling one, and out of scope unless asked
 * for explicitly.
 */
export function AgentUnreadProvider({ children }: { readonly children: ReactNode }) {
  const [count, setCount] = useState(0);
  const publish = useCallback((next: number) => {
    setCount((current) => (current === next ? current : next));
  }, []);
  const value = useMemo(() => ({ count, publish }), [count, publish]);
  return <AgentUnreadContext.Provider value={value}>{children}</AgentUnreadContext.Provider>;
}

export function useAgentUnread() {
  return useContext(AgentUnreadContext);
}
