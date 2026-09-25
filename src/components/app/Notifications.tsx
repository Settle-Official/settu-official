"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useActiveWallet } from "./ActiveWallet";
import { enabledOfframpChainLabels } from "@/lib/cctp/evm-chains";
import { fiatSymbol } from "@/lib/format/currency";
import { useWalletHistory, type HistoryRow } from "./useWalletHistory";

export type NotificationTone = "info" | "success" | "failed";

/** A label/value pair shown in the detail view. */
export interface NotificationDetail {
  readonly label: string;
  readonly value: string;
  /** Long identifiers (hashes, order ids) wrap instead of truncating. */
  readonly mono?: boolean;
}

export interface AppNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly timestamp: number;
  readonly tone: NotificationTone;
  readonly read: boolean;
  readonly details: readonly NotificationDetail[];
}

// Which notifications have been read, by id.
//
// The server (/api/notifications/[address]) is the real store, so read state
// follows a wallet between devices. localStorage stays on as a cache: it
// paints the right state before the fetch lands and keeps working when the
// request fails or no wallet is connected, neither of which a network call
// can do on its own.
const READ_KEY = "settu_notifications_read_v1";

function loadRead(): string[] {
  try {
    const raw = localStorage.getItem(READ_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Blocked storage: everything reads as unread, which is the safe way
    // round — the user sees the notification rather than silently missing it.
    return [];
  }
}

function saveRead(ids: string[]) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(ids));
  } catch {
    // Nothing to persist; the in-memory state still works for this session.
  }
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

// The announcement that used to interrupt as a popup on landing. Same copy,
// same chain allowlist (so it never names a chain that isn't live), now just
// another notification the user can come back to.
const chains = enabledOfframpChainLabels();
const ANNOUNCEMENT: Omit<AppNotification, "read"> = {
  id: "announcement-v1",
  title: "Announcement",
  body:
    chains.length > 0
      ? `New — offramp your USDC straight from ${formatList(chains)}, on top of Stellar. Convert to your bank in minutes.`
      : "Settu is now available on mobile. You can add to home screen for easy access.",
  // Fixed, not Date.now(): a timestamp that moved every render would keep
  // re-sorting the list and could never be meaningfully "older" than a
  // transaction. This is when the announcement shipped.
  timestamp: Date.parse("2026-09-09T00:00:00Z"),
  tone: "info",
  details:
    chains.length > 0
      ? [{ label: "Supported source chains", value: chains.join(", ") }]
      : [],
};

function fromHistory(row: HistoryRow): Omit<AppNotification, "read"> | null {
  // Only settled outcomes are worth notifying about; anything still moving is
  // already visible on the screen the user started it from.
  if (row.status === "pending") return null;

  const failed = row.status === "failed";
  const isOnramp = row.kind === "onramp";
  const fiat = Number(row.fiatAmount);
  const money = Number.isFinite(fiat) && fiat > 0
    ? `${fiatSymbol(row.currency)}${fiat.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : null;
  const usdc = row.usdc > 0 ? `${row.usdc} USDC` : null;

  const title = isOnramp
    ? failed ? "Onramp failed" : "Onramp delivered"
    : failed ? "Offramp failed" : "Offramp completed";

  // Never the raw provider error: those are written for operators, and
  // "account name mismatch" or a bare gateway code tells the user nothing
  // they can act on. They get told where their money stands and who to ask;
  // the order id below is what support actually needs to look it up.
  // Never claim the funds are safe. A failed offramp splits two ways: it
  // failed before anything moved, or the USDC was burned on-chain and the
  // payout never completed — and from here those look identical unless a
  // transaction hash was recorded. Telling everyone "your USDC hasn't left
  // your wallet" was wrong for exactly the people who most needed help, and
  // sent them away reassured while their money sat stranded.
  const debited = Boolean(row.txHash);
  const body = failed
    ? isOnramp
      ? "This didn't complete. If you already sent the money, report it under Help with the account you paid from and we'll trace it."
      : debited
        ? "Your USDC left your wallet but the payout didn't complete. Report it under Help with the wallet address you sent from and we'll recover it."
        : "This didn't complete. If your USDC was debited, report it under Help with the wallet address you sent from and we'll recover it."
    : isOnramp
      ? `${usdc ?? "Your USDC"} delivered to your Stellar wallet.`
      : `${money ?? "Your payout"} sent to ${row.bank ?? "your bank account"}${
          row.accountName ? ` · ${row.accountName}` : ""
        }.`;

  const details: NotificationDetail[] = [];
  const add = (label: string, value: string | undefined, mono = false) => {
    if (value) details.push({ label, value, mono });
  };

  add("Type", isOnramp ? "Onramp" : "Offramp");
  add("Status", failed ? "Failed" : "Completed");
  add("Started from", row.initiator === "agent" ? "Agent Mode" : row.initiator === "form" ? "Offramp form" : undefined);
  add("Amount", usdc ?? undefined);
  // "You received" would be a lie on a failed payout — the fiat figure is
  // what was attempted, not what landed.
  add(
    failed ? (isOnramp ? "Amount attempted" : "Payout attempted") : isOnramp ? "You paid" : "You received",
    money ?? undefined,
  );
  if (money && row.usdc > 0 && Number.isFinite(fiat)) {
    add("Rate", `${fiatSymbol(row.currency)}${Math.round(fiat / row.usdc).toLocaleString("en-US")}/USD`);
  }
  add("Source chain", row.sourceChain);
  add("Bank", row.bank);
  add("Account name", row.accountName);
  add("Account number", row.accountNumber);
  add("Date", new Date(row.timestamp).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }));
  add("Order ID", row.orderId, true);
  // The raw provider error stays out of the detail list too, for the same
  // reason it stays out of the body above.

  return {
    id: `tx-${row.id}`,
    title,
    body,
    timestamp: row.timestamp,
    tone: failed ? "failed" : "success",
    details,
  };
}

interface NotificationsValue {
  readonly items: readonly AppNotification[];
  readonly unreadCount: number;
  readonly markAllRead: () => void;
  readonly markAllUnread: () => void;
  readonly markRead: (id: string) => void;
}

const NotificationsContext = createContext<NotificationsValue>({
  items: [],
  unreadCount: 0,
  markAllRead: () => {},
  markAllUnread: () => {},
  markRead: () => {},
});

/**
 * Mounted at the /app layout so the sidebar badge and the header bell can
 * read the unread count on every screen, not just the Notification tab.
 *
 * It owns the single history read the notifications are derived from; the
 * Notification page consumes this rather than fetching again.
 */
export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  // The last-used wallet, whatever its chain: history is recorded under the
  // address a transfer was paid from.
  const { active } = useActiveWallet();
  const address = active.isConnected ? active.address : undefined;
  const { rows } = useWalletHistory(address);
  const [readIds, setReadIds] = useState<readonly string[]>([]);
  // The cached copy paints first. Reading it in an effect rather than in
  // useState's initializer keeps the first client render identical to the
  // server's, so hydration doesn't mismatch.
  useEffect(() => setReadIds(loadRead()), []);

  // Then the server's copy replaces it, which is what carries read state
  // over from another device. Authoritative rather than merged: a union
  // would resurrect anything the user had marked unread somewhere else.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetch(`/api/notifications/${encodeURIComponent(address)}`)
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled || payload?.error) return;
        const read: unknown = payload?.data?.read;
        if (!Array.isArray(read)) return;
        const ids = read.filter((v): v is string => typeof v === "string");
        setReadIds(ids);
        saveRead(ids);
      })
      .catch(() => {
        // Offline or the store is down: the cached copy already rendered and
        // stays usable, so there's nothing to recover here.
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  /**
   * Sends a change to the server. Fire-and-forget by design: the local
   * update has already been applied, so blocking the UI on a round trip
   * would only make marking something read feel slow. A failed sync is
   * reconciled by the fetch above on the next load.
   */
  const sync = useCallback(
    (body: { add?: string[]; clear?: boolean }) => {
      if (!address) return;
      void fetch(`/api/notifications/${encodeURIComponent(address)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    },
    [address],
  );

  const base = useMemo(() => {
    const fromRows = rows
      .map(fromHistory)
      .filter((n): n is Omit<AppNotification, "read"> => n !== null);
    return [...fromRows, ANNOUNCEMENT].sort((a, b) => b.timestamp - a.timestamp);
  }, [rows]);

  const items = useMemo(() => {
    const read = new Set(readIds);
    return base.map((n) => ({ ...n, read: read.has(n.id) }));
  }, [base, readIds]);

  const unreadCount = useMemo(() => items.filter((n) => !n.read).length, [items]);

  const persist = useCallback((ids: string[]) => {
    setReadIds(ids);
    saveRead(ids);
  }, []);

  const markAllRead = useCallback(() => {
    const ids = base.map((n) => n.id);
    persist(ids);
    sync({ add: ids });
  }, [base, persist, sync]);

  // Clears the whole set rather than only the ids currently listed, so
  // nothing stays quietly marked read once the user has asked for the
  // opposite.
  const markAllUnread = useCallback(() => {
    persist([]);
    sync({ clear: true });
  }, [persist, sync]);

  const markRead = useCallback(
    (id: string) => {
      setReadIds((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        saveRead(next);
        return next;
      });
      sync({ add: [id] });
    },
    [sync],
  );

  const value = useMemo(
    () => ({ items, unreadCount, markAllRead, markAllUnread, markRead }),
    [items, unreadCount, markAllRead, markAllUnread, markRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext);
}
