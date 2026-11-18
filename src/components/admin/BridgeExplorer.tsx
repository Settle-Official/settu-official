"use client";

/**
 * Admin bridge explorer (Task 17a): every bridge transaction, newest first,
 * refreshed live. Polls every 10 s only while the tab is visible (no SSE).
 * Revive reuses the Task 17 endpoint. Structural types only: this client
 * component must not import server modules.
 */

import { AdminNav } from "./AdminNav";
import { BridgeAdminPanel } from "./BridgeAdminPanel";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ageLabel,
  nativeAmount,
  pillStatus,
  recipientView,
  shortAddr,
  shouldPoll,
  usdc,
  type PillStatus,
} from "@/lib/bridge/explorer-format";

const CARD = "rounded-[20px] border border-white/15 bg-white/[0.04] p-[24px] max-[700px]:p-[16px]";
const FIELD =
  "h-[40px] rounded-[14px] bg-transparent px-[12px] font-[family-name:var(--font-sora)] text-[13px] text-white outline-none placeholder:text-[#8d8c8c]";
const BORDER = { border: "1px solid rgba(255,255,255,0.14)" };
const GOLD = { backgroundColor: "#c9a962" };
const PRIMARY =
  "h-[40px] rounded-[40px] px-[20px] font-[family-name:var(--font-sora)] text-[13px] font-medium text-[#1a1a1a] disabled:opacity-50";
const GHOST =
  "h-[36px] rounded-[14px] px-[14px] font-[family-name:var(--font-sora)] text-[13px] text-[#e6e3e3] disabled:opacity-50";
const H2 = "font-fraunces text-[22px] text-white";
const TEXT = "font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#d6d3d3]";
const MUTED = "font-[family-name:var(--font-sora)] text-[12px] leading-[18px] text-[#8d8c8c]";
const MONO = "break-all font-[family-name:var(--font-inter)] text-[12px] text-[#a19d9d]";
const COLS = "grid-cols-[110px_150px_70px_minmax(0,1.6fr)_minmax(0,1.1fr)_100px_minmax(0,0.9fr)_50px]";

const PILL: Record<PillStatus, { label: string; color: string }> = {
  submitted: { label: "Submitted", color: "#AE9611" },
  verifying: { label: "Verifying", color: "#AE9611" },
  delivering: { label: "Delivering", color: "#4C8FCA" },
  completed: { label: "Completed", color: "#109F21" },
  failed: { label: "Failed", color: "#CA4C4C" },
  stuck: { label: "Stuck", color: "#E07B39" },
};

const CHAINS = [
  "arbitrum", "avalanche", "base", "ethereum", "optimism", "polygon", "stellar", "solana",
];
const POLL_MS = 10_000;
const TOTALS_EVERY = 3; // polls between totals refreshes (server caches 30 s)

interface Row {
  id: string;
  status: string;
  stuck: boolean;
  recordStatus: string;
  source: string;
  dest: string;
  sourceLabel: string;
  destLabel: string;
  user: string;
  recipient?: string;
  recipientIsTokenAccount?: boolean;
  recipientUnknown?: boolean;
  speed: string;
  sendAtomic: string;
  receiveMinAtomic: string;
  receiveMinIsBurn?: boolean;
  receivedAtomic?: string;
  settuFeeAtomic: string;
  networkFeeAtomic: string;
  nativeFeeAtomic: string;
  nativeSymbol: string;
  nativeDecimals: number;
  sourceTx: string;
  destTx?: string;
  sourceTxUrl?: string;
  destTxUrl?: string;
  createdAt: number;
  updatedAt: number;
  attestedAt?: number;
  attempts: number;
  lastError?: string;
  fellBackToStandard: boolean;
}
interface Totals {
  count: number;
  volumeAtomic: string;
  feesAtomic: string;
  inProgress: number;
  failedOrStuck: number;
  truncated: boolean;
}
interface Filters {
  status: string;
  source: string;
  dest: string;
  speed: string;
  from: string;
  to: string;
  q: string;
}
const NO_FILTERS: Filters = { status: "", source: "", dest: "", speed: "", from: "", to: "", q: "" };

class AuthError extends Error {}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (res.status === 401) throw new AuthError("Unauthorized");
  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload as T;
}

function query(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (f.status) p.set("status", f.status);
  if (f.source) p.set("source", f.source);
  if (f.dest) p.set("dest", f.dest);
  if (f.speed) p.set("speed", f.speed);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.from) p.set("from", String(new Date(`${f.from}T00:00:00`).getTime()));
  if (f.to) p.set("to", String(new Date(`${f.to}T23:59:59.999`).getTime()));
  return p.toString();
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Pill({ row }: { readonly row: Row }) {
  const p = PILL[pillStatus(row)] ?? { label: row.status, color: "#8D8C8C" };
  return (
    <span
      style={{ backgroundColor: `${p.color}26`, color: p.color, border: `1px solid ${p.color}66` }}
      className="inline-block rounded-full px-[10px] py-[2px] font-[family-name:var(--font-sora)] text-[12px]"
    >
      {p.label}
    </span>
  );
}

function CopyAddr({ text, tag, unknown }: { readonly text: string; readonly tag?: string; readonly unknown?: boolean }) {
  const [done, setDone] = useState(false);
  if (unknown) return <span className={MUTED}>{text}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-[6px]">
      <code className="font-[family-name:var(--font-inter)] text-[12px] text-[#d6d3d3]" title={text}>
        {shortAddr(text)}
      </code>
      {tag && (
        <span style={BORDER} className="rounded-full px-[6px] font-[family-name:var(--font-sora)] text-[10px] text-[#a19d9d]">
          {tag}
        </span>
      )}
      <button
        type="button"
        aria-label={`Copy ${text}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        className="text-[11px] text-[#c9a962]"
      >
        {done ? "copied" : "copy"}
      </button>
    </span>
  );
}

function TxLink({ hash, url, label }: { readonly hash?: string; readonly url?: string; readonly label: string }) {
  if (!hash) return <span className={MUTED}>-</span>;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-[12px] text-[#c9a962] underline">
      {label}
    </a>
  ) : (
    <code className={MONO}>{shortAddr(hash)}</code>
  );
}

export function BridgeExplorer() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [operator, setOperator] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [totals, setTotals] = useState<Record<"24h" | "7d", Totals | null>>({ "24h": null, "7d": null });
  const [open, setOpen] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [reviving, setReviving] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string> | null>(null);
  const tick = useRef(0);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const loadedRef = useRef(0);
  loadedRef.current = rows.length;

  const filtering = Object.values(applied).some((v) => v.trim() !== "");
  const named = operator.trim().length > 1;

  const loadTotals = useCallback(async () => {
    const [a, b] = await Promise.all([
      api<{ totals: Totals }>("/api/admin/bridge/explorer?totals=24h"),
      api<{ totals: Totals }>("/api/admin/bridge/explorer?totals=7d"),
    ]);
    setTotals({ "24h": a.totals, "7d": b.totals });
  }, []);

  /** First page: replaces the head of the list, keeps older loaded pages, animates new ids. */
  const refresh = useCallback(async (reset = false) => {
    try {
      const r = await api<{ rows: Row[]; nextCursor?: string }>(
        `/api/admin/bridge/explorer?${query(appliedRef.current, { limit: "50" })}`,
      );
      setAuthed(true);
      setNow(Date.now());
      const prev = seen.current;
      const added = new Set<string>();
      if (prev && !reset) for (const x of r.rows) if (!prev.has(x.id)) added.add(x.id);
      seen.current = new Set(r.rows.map((x) => x.id));
      setFresh(added);
      setRows((old) => {
        if (reset || r.rows.length === 0) return r.rows;
        const oldest = r.rows[r.rows.length - 1].createdAt;
        const tail = r.nextCursor ? old.filter((x) => x.createdAt < oldest) : [];
        return [...r.rows, ...tail];
      });
      // A poll only owns the cursor while no older page has been loaded.
      setNextCursor((c) => (reset || loadedRef.current <= r.rows.length ? r.nextCursor : c));
      setError(null);
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
      else setError(e instanceof Error ? e.message : "Couldn't load bridges.");
    }
  }, []);

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const r = await api<{ rows: Row[]; nextCursor?: string }>(
        `/api/admin/bridge/explorer?${query(applied, { limit: "50", cursor: nextCursor })}`,
      );
      setRows((old) => [...old, ...r.rows.filter((x) => !old.some((o) => o.id === x.id))]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more.");
    }
  };

  // Initial load, and again whenever applied filters change.
  useEffect(() => {
    seen.current = null;
    void refresh(true);
    void loadTotals().catch(() => {});
  }, [applied, refresh, loadTotals]);

  // Live polling: only while the tab is visible; pause on hidden, resume on visible.
  useEffect(() => {
    // Filtered/search lists cost ~10 Redis commands per request: no auto-poll.
    if (authed !== true || filtering) {
      setLive(false);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        tick.current += 1;
        void refresh();
        if (tick.current % TOTALS_EVERY === 0) void loadTotals().catch(() => {});
      }, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const sync = () => {
      const visible = shouldPoll(document.visibilityState);
      setLive(visible);
      if (visible) {
        // Catch up immediately on return to the tab, then keep the cadence.
        if (!timer) void refresh();
        start();
      } else stop();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop();
    };
  }, [authed, filtering, refresh, loadTotals]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || "Login failed");
      setPassword("");
      setAuthed(null);
      void refresh(true);
      void loadTotals().catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const revive = async (id: string) => {
    setError(null);
    if (!named) return setError("Enter your name at the top first. Every action is attributed.");
    if (!window.confirm(`Revive bridge ${id}?\n\nThis resets the failed transfer and schedules delivery.`)) return;
    setReviving(id);
    try {
      await api("/api/admin/bridge/revive", { method: "POST", body: JSON.stringify({ id, operator }) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revive failed");
    } finally {
      setReviving(null);
    }
  };

  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  const apply = (e?: FormEvent) => {
    e?.preventDefault();
    setApplied(filters);
  };

  if (authed === false) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-[20px] p-[24px]">
        <h1 className="font-fraunces text-[28px] text-white">Bridge explorer</h1>
        <form onSubmit={login} className={`${CARD} flex flex-col gap-[16px]`}>
          <label className="flex flex-col gap-[8px]">
            <span className={TEXT}>Admin password</span>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} style={BORDER} className={`${FIELD} h-[52px]`} />
          </label>
          <button type="submit" disabled={busy || !password} style={GOLD} className={PRIMARY}>
            {busy ? "Checking…" : "Continue"}
          </button>
          {error && <p className="text-[13px] text-[#ca4c4c]">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col gap-[20px] p-[24px] max-[700px]:p-[16px]">
      <style>{`@keyframes bx-in{from{opacity:0;transform:translateY(-8px);background:rgba(201,169,98,.25)}to{opacity:1;transform:none;background:transparent}}.bx-new{animation:bx-in .9s ease-out}@media (prefers-reduced-motion:reduce){.bx-new{animation:none}}`}</style>

      <header className="flex flex-wrap items-center justify-between gap-[12px]">
        <div className="flex items-center gap-[14px]">
          <h1 className="font-fraunces text-[28px] text-white">Bridge explorer</h1>
          <span
            role="status"
            style={{ color: live ? "#109F21" : "#8D8C8C", border: `1px solid ${live ? "#109F2166" : "rgba(255,255,255,0.14)"}` }}
            className="inline-flex items-center gap-[6px] rounded-full px-[10px] py-[2px] font-[family-name:var(--font-sora)] text-[12px]"
          >
            <span style={{ backgroundColor: live ? "#109F21" : "#8D8C8C" }} className="size-[7px] rounded-full" />
            {live ? "Live" : "Paused"}
          </span>
          {filtering && (
            <span className={MUTED}>
              Live updates paused while filtering{" "}
              <button type="button" onClick={() => void refresh(true)} className="text-[#c9a962] underline">Refresh</button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-[10px]">
          <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Your name (for actions)" style={BORDER} className={FIELD} />
        </div>
      </header>
      <AdminNav />

      {error && <p className="text-[13px] text-[#ca4c4c]">{error}</p>}

      <section aria-label="Totals" className="grid grid-cols-2 gap-[12px] max-[700px]:grid-cols-1">
        {(["24h", "7d"] as const).map((w) => {
          const t = totals[w];
          return (
            <div key={w} className={`${CARD} flex flex-col gap-[10px]`}>
              <span className={MUTED}>Last {w === "24h" ? "24 hours" : "7 days"}{t?.truncated ? " (newest 2,000 only)" : ""}</span>
              {t ? (
                <div className="grid grid-cols-5 gap-[8px] max-[700px]:grid-cols-3">
                  <Stat label="Bridges" value={String(t.count)} />
                  <Stat label="Volume" value={`${usdc(t.volumeAtomic)} USDC`} />
                  <Stat label="Fees" value={`${usdc(t.feesAtomic)} USDC`} />
                  <Stat label="In progress" value={String(t.inProgress)} />
                  <Stat label="Failed / stuck" value={String(t.failedOrStuck)} warn={t.failedOrStuck > 0} />
                </div>
              ) : (
                <span className={MUTED}>Loading…</span>
              )}
            </div>
          );
        })}
      </section>

      <form onSubmit={apply} className={`${CARD} flex flex-wrap items-end gap-[10px]`}>
        <Select label="Status" value={filters.status} onChange={set("status")} options={["submitted", "verifying", "delivering", "completed", "failed", "stuck"]} />
        <Select label="From chain" value={filters.source} onChange={set("source")} options={CHAINS} />
        <Select label="To chain" value={filters.dest} onChange={set("dest")} options={CHAINS} />
        <Select label="Speed" value={filters.speed} onChange={set("speed")} options={["fast", "standard"]} />
        <label className="flex flex-col gap-[4px]"><span className={MUTED}>From date</span>
          <input type="date" value={filters.from} onChange={set("from")} style={BORDER} className={FIELD} /></label>
        <label className="flex flex-col gap-[4px]"><span className={MUTED}>To date</span>
          <input type="date" value={filters.to} onChange={set("to")} style={BORDER} className={FIELD} /></label>
        <label className="flex min-w-[220px] flex-1 flex-col gap-[4px]"><span className={MUTED}>Search tx hash or address</span>
          <input value={filters.q} onChange={set("q")} placeholder="0x… or address (start of it)" style={BORDER} className={FIELD} /></label>
        <button type="submit" style={GOLD} className={PRIMARY}>Apply</button>
        <button type="button" style={BORDER} className={GHOST} onClick={() => { setFilters(NO_FILTERS); setApplied(NO_FILTERS); }}>Clear</button>
      </form>

      <div className={`${CARD} flex flex-col gap-[4px] overflow-x-auto !p-[12px]`}>
        <h2 className={`${H2} px-[8px] pb-[8px]`}>Transactions</h2>
        <div className="min-w-[1020px]">
          <div className={`grid ${COLS} gap-[10px] px-[8px] pb-[6px] ${MUTED}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
            <span>Time</span><span>Route</span><span>Speed</span><span>Sender → recipient</span>
            <span>Sent / received / fee</span><span>Status</span><span>Txs</span><span>Age</span>
          </div>
          {rows.length === 0 && authed === true && <p className={`${MUTED} p-[12px]`}>No bridges match.</p>}
          {rows.map((r) => {
            const rv = recipientView(r);
            const fee = BigInt(r.settuFeeAtomic) + BigInt(r.networkFeeAtomic);
            const isOpen = open === r.id;
            return (
              <div key={r.id} className={fresh.has(r.id) ? "bx-new" : undefined} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : r.id); } }}
                  className={`grid ${COLS} cursor-pointer items-center gap-[10px] px-[8px] py-[10px] hover:bg-white/[0.03] ${TEXT}`}
                >
                  <span>{when(r.createdAt)}</span>
                  <span>{r.sourceLabel} → {r.destLabel}</span>
                  <span className="capitalize">{r.speed}</span>
                  <span className="flex flex-col gap-[2px]" onClick={(e) => e.stopPropagation()}>
                    <CopyAddr text={r.user} />
                    <span className="flex items-center gap-[6px]"><span className={MUTED}>→</span><CopyAddr {...rv} /></span>
                  </span>
                  <span className="flex flex-col">
                    <span>{usdc(r.sendAtomic)} sent</span>
                    <span className={MUTED}>
                      {r.receivedAtomic ? `${usdc(r.receivedAtomic)} received` : `${r.receiveMinIsBurn ? "~" : ">= "}${usdc(r.receiveMinAtomic)} min`} · {usdc(fee.toString())} fee
                    </span>
                  </span>
                  <Pill row={r} />
                  <span className="flex flex-col gap-[2px]" onClick={(e) => e.stopPropagation()}>
                    <TxLink hash={r.sourceTx} url={r.sourceTxUrl} label="source" />
                    <TxLink hash={r.destTx} url={r.destTxUrl} label="dest" />
                  </span>
                  <span className={MUTED}>{ageLabel(now - r.createdAt)}</span>
                </div>

                {isOpen && (
                  <div className="grid grid-cols-3 gap-[16px] bg-white/[0.02] p-[16px] max-[900px]:grid-cols-1">
                    <div className="flex flex-col gap-[4px]">
                      <span className={MUTED}>Fee breakdown</span>
                      <span className={TEXT}>Settu fee {usdc(r.settuFeeAtomic)} USDC</span>
                      <span className={TEXT}>Network fee {usdc(r.networkFeeAtomic)} USDC</span>
                      <span className={TEXT}>Native fee {nativeAmount(r.nativeFeeAtomic, r.nativeDecimals, r.nativeSymbol)}</span>
                      {r.fellBackToStandard && <span className={MUTED}>Fell back to Standard</span>}
                    </div>
                    <div className="flex flex-col gap-[4px]">
                      <span className={MUTED}>Timeline</span>
                      <span className={TEXT}>Burned {when(r.createdAt)}</span>
                      <span className={TEXT}>Attested {r.attestedAt ? when(r.attestedAt) : "pending"}</span>
                      <span className={TEXT}>
                        Minted {r.destTx ? when(r.updatedAt) : "pending"}
                      </span>
                      <span className={MUTED}>Stage: {r.recordStatus} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}</span>
                    </div>
                    <div className="flex flex-col gap-[6px]">
                      <span className={MUTED}>Transaction</span>
                      <code className={MONO}>{r.id}</code>
                      <span className={MUTED}>Sender</span><code className={MONO}>{r.user}</code>
                      <span className={MUTED}>Recipient</span>
                      <code className={MONO}>{rv.text}{rv.tag ? ` (${rv.tag})` : ""}</code>
                    </div>
                    {r.lastError && (
                      <p className="col-span-full text-[13px] text-[#ca4c4c]">Last error: {r.lastError}</p>
                    )}
                    {r.recordStatus === "failed" && (
                      <div className="col-span-full">
                        <button
                          type="button"
                          onClick={() => void revive(r.id)}
                          disabled={reviving !== null || !named}
                          title={named ? undefined : "Enter your name at the top first"}
                          style={GOLD}
                          className={PRIMARY}
                        >
                          {reviving === r.id ? "Reviving…" : "Revive / retry mint"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {nextCursor && (
          <div className="pt-[10px]">
            <button type="button" onClick={() => void loadMore()} style={BORDER} className={GHOST}>Load older</button>
          </div>
        )}
      </div>

      {/* Relayer gas: part of the live picture, next to the bridges it pays for. */}
      {authed && <BridgeAdminPanel operator={operator} sections={["relayers"]} title="Relayers" />}
    </main>
  );
}

function Stat({ label, value, warn }: { readonly label: string; readonly value: string; readonly warn?: boolean }) {
  return (
    <div className="flex flex-col gap-[2px]">
      <span className={MUTED}>{label}</span>
      <span className="font-[family-name:var(--font-sora)] text-[16px]" style={{ color: warn ? "#E07B39" : "#fff" }}>{value}</span>
    </div>
  );
}

function Select({ label, value, onChange, options }: { readonly label: string; readonly value: string; readonly onChange: (e: { target: { value: string } }) => void; readonly options: string[] }) {
  return (
    <label className="flex flex-col gap-[4px]">
      <span className={MUTED}>{label}</span>
      <select value={value} onChange={onChange} style={BORDER} className={`${FIELD} bg-[#191818] capitalize`}>
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
