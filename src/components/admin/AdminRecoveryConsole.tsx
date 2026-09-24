"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

/** Mirrors OrderDiagnosis on the server; kept structural so this client
 *  component never imports server-only modules. */
interface Diagnosis {
  orderId: string;
  verdict: "stranded-burn" | "bridge-stalled" | "record-stale" | "no-burn" | "unknown" | "healthy";
  summary: string;
  recoverable: boolean;
  meta: { amountUsdc?: number; senderAddress?: string; sourceChain?: string } | null;
  payoutStatus: string | null;
  record: { status?: string } | null;
  transfer: { status?: string } | null;
  onChainBurn: { txHash: string; amountAtomic: string } | null;
  lookupError: string | null;
  sweepWouldSkip: string | null;
}

interface AuditEntry {
  at: number;
  action: string;
  orderId: string;
  operator: string;
  outcome: string;
  detail?: string;
}

const VERDICT_STYLE: Record<Diagnosis["verdict"], { label: string; color: string }> = {
  "stranded-burn": { label: "Stranded burn", color: "#CA4C4C" },
  "bridge-stalled": { label: "Bridge stalled", color: "#AE9611" },
  "record-stale": { label: "Record stale", color: "#AE9611" },
  "no-burn": { label: "No burn", color: "#8D8C8C" },
  unknown: { label: "Couldn't check", color: "#CA4C4C" },
  healthy: { label: "Healthy", color: "#109F21" },
};

const CARD =
  "rounded-[20px] border border-white/15 bg-white/[0.04] p-[24px] max-[700px]:p-[16px]";
const FIELD =
  "h-[52px] w-full rounded-[14px] bg-transparent px-[16px] font-[family-name:var(--font-sora)] text-[15px] text-white outline-none placeholder:text-[#8d8c8c]";
const LOG_COLS = "grid-cols-[130px_110px_130px_130px_minmax(0,1fr)]";

export function AdminRecoveryConsole() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [operator, setOperator] = useState("");
  const [query, setQuery] = useState("");
  const [orders, setOrders] = useState<Diagnosis[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Whether the modal is open is tracked separately from whether the data
  // has arrived. Sharing one piece of state made the button look dead on a
  // slow fetch, and the second click then closed what the first had opened.
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);

  const named = operator.trim().length > 1;

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
      setAuthed(true);
      setPassword("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await fetch("/api/admin/audit?limit=50");
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load audit log");
      setAudit(payload.data.entries);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const openAudit = useCallback(() => {
    // Opens immediately and loads behind it, so a slow fetch can never make
    // the button look like it did nothing.
    setAuditOpen(true);
    void loadAudit();
  }, [loadAudit]);

  useEffect(() => {
    if (!auditOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAuditOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [auditOpen]);

  const lookup = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q) return;
      setError(null);
      setBusy(true);
      setOrders(null);
      try {
        // A Paycrest order id is a UUID; anything else is treated as a wallet.
        const isOrderId = /^[0-9a-f-]{36}$/i.test(q);
        const res = await fetch(
          `/api/admin/offramp/diagnose?${isOrderId ? "orderId" : "wallet"}=${encodeURIComponent(q)}`,
        );
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Lookup failed");
        setOrders(payload.data.orders);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [query],
  );

  const recover = async (orderId: string) => {
    if (!named) {
      setError("Enter your name at the top first — every action is attributed.");
      return;
    }
    // Spelled out rather than hidden behind a one-word confirm: this moves
    // real money and cannot be undone.
    if (
      !window.confirm(
        `Register the on-chain burn for order ${orderId}?\n\n` +
          `This mints the USDC to Paycrest and triggers the payout. It is safe ` +
          `to repeat, but it cannot be undone.`,
      )
    ) {
      return;
    }
    setActing(orderId);
    setError(null);
    try {
      const res = await fetch("/api/admin/offramp/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, operator }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Recovery failed");
      // Replace the row with the server's fresh diagnosis rather than
      // assuming the action worked.
      const fresh: Diagnosis = payload.data.diagnosis;
      setOrders((prev) => prev?.map((o) => (o.orderId === orderId ? fresh : o)) ?? [fresh]);
      if (auditOpen) void loadAudit();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActing(null);
    }
  };

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-[20px] p-[24px]">
        <h1 className="font-fraunces text-[28px] text-white">Recovery console</h1>
        <form onSubmit={login} className={`${CARD} flex flex-col gap-[16px]`}>
          <label className="flex flex-col gap-[8px]">
            <span className="font-[family-name:var(--font-sora)] text-[13px] text-[#a19d9d]">
              Admin password
            </span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ border: "1px solid rgba(255,255,255,0.14)" }}
              className={FIELD}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !password}
            style={{ backgroundColor: "#c9a962" }}
            className="h-[50px] rounded-[40px] font-[family-name:var(--font-sora)] text-[15px] font-medium text-[#1a1a1a] disabled:opacity-50"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
          {error && (
            <p className="font-[family-name:var(--font-sora)] text-[13px] text-[#ca4c4c]">
              {error}
            </p>
          )}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1100px] flex-col gap-[24px] p-[24px]">
      <header className="flex flex-wrap items-baseline justify-between gap-[12px]">
        <h1 className="font-fraunces text-[28px] text-white">
          Settu Admin Recovery console
        </h1>
        <div className="flex items-center gap-[12px]">
          <button
            type="button"
            onClick={openAudit}
            style={{ border: "1px solid rgba(255,255,255,0.14)" }}
            className="h-[40px] rounded-[14px] px-[16px] font-[family-name:var(--font-sora)] text-[14px] text-[#e6e3e3]"
          >
            Audit log
          </button>
          <input
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="Your name (required)"
            aria-label="Your name, required for the audit log"
            style={{ border: `1px solid ${named ? "rgba(255,255,255,0.14)" : "#ca4c4c"}` }}
            className="h-[40px] w-[240px] rounded-[14px] bg-transparent px-[14px] font-[family-name:var(--font-sora)] text-[14px] text-white outline-none placeholder:text-[#8d8c8c]"
          />
        </div>
      </header>

      <form onSubmit={lookup} className="flex flex-wrap gap-[12px]">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Wallet address or Paycrest order ID"
          style={{ border: "1px solid rgba(255,255,255,0.14)" }}
          className={`${FIELD} min-w-[280px] flex-1`}
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          style={{ backgroundColor: "#c9a962" }}
          className="h-[52px] rounded-[40px] px-[28px] font-[family-name:var(--font-sora)] text-[15px] font-medium text-[#1a1a1a] disabled:opacity-50"
        >
          {busy ? "Looking…" : "Diagnose"}
        </button>
      </form>

      {error && (
        <p className={`${CARD} font-[family-name:var(--font-sora)] text-[14px] text-[#ca4c4c]`}>
          {error}
        </p>
      )}

      {orders?.length === 0 && (
        <p className={`${CARD} font-[family-name:var(--font-sora)] text-[15px] text-[#bab6b6]`}>
          No orders found. Order metadata expires after 48 hours, so an older
          transfer may have nothing left to look up.
        </p>
      )}

      {orders?.map((o) => {
        const style = VERDICT_STYLE[o.verdict];
        return (
          <section key={o.orderId} className={`${CARD} flex flex-col gap-[16px]`}>
            <div className="flex flex-wrap items-center justify-between gap-[12px]">
              <div className="flex items-center gap-[12px]">
                <span
                  style={{ backgroundColor: style.color }}
                  className="size-[10px] shrink-0 rounded-full"
                />
                <span className="font-fraunces text-[20px] text-white">{style.label}</span>
                <code className="font-[family-name:var(--font-inter)] text-[13px] text-[#8d8c8c]">
                  {o.orderId}
                </code>
              </div>
              {o.recoverable && (
                <button
                  type="button"
                  onClick={() => recover(o.orderId)}
                  disabled={acting === o.orderId || !named}
                  title={named ? undefined : "Enter your name at the top first"}
                  style={{ backgroundColor: "#c9a962" }}
                  className="h-[44px] rounded-[40px] px-[22px] font-[family-name:var(--font-sora)] text-[14px] font-medium text-[#1a1a1a] disabled:opacity-50"
                >
                  {acting === o.orderId ? "Recovering…" : "Register burn & pay out"}
                </button>
              )}
            </div>

            <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-[#d6d3d3]">
              {o.summary}
            </p>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-[12px]">
              <Cell label="Amount" value={o.meta?.amountUsdc != null ? `${o.meta.amountUsdc} USDC` : "—"} />
              <Cell label="Paycrest / cache" value={o.payoutStatus ?? "none"} />
              <Cell label="Our record" value={o.record?.status ?? "none"} />
              <Cell label="CCTP transfer" value={o.transfer?.status ?? "none"} />
              <Cell
                label="On-chain burn"
                value={o.onChainBurn ? "found" : o.lookupError ? "lookup failed" : "none"}
              />
              <Cell label="Source chain" value={o.meta?.sourceChain ?? "—"} />
            </div>

            {o.sweepWouldSkip && (
              <p className="font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#8d8c8c]">
                Daily sweep would skip this: {o.sweepWouldSkip}.
              </p>
            )}

            {o.onChainBurn && (
              <code className="break-all font-[family-name:var(--font-inter)] text-[12px] text-[#8d8c8c]">
                burn {o.onChainBurn.txHash}
              </code>
            )}
          </section>
        );
      })}

      {auditOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Audit log"
          className="fixed inset-0 z-50 flex items-center justify-center p-[24px]"
        >
          <button
            type="button"
            aria-label="Close audit log"
            onClick={() => setAuditOpen(false)}
            style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
            className="absolute inset-0 backdrop-blur-md"
          />
          <div
            style={{ border: "1px solid rgba(255,255,255,0.15)" }}
            className="relative z-10 flex max-h-[80vh] w-full max-w-[1000px] flex-col gap-[18px] rounded-[24px] bg-[#1e1c1c] p-[28px] shadow-[0_28px_60px_rgba(0,0,0,0.6)] max-[700px]:p-[18px]"
          >
            <div className="flex items-start justify-between gap-[16px]">
              <div className="flex flex-col gap-[4px]">
                <h2 className="font-fraunces text-[22px] text-white">Audit log</h2>
                <span className="font-[family-name:var(--font-sora)] text-[13px] text-[#8d8c8c]">
                  {auditLoading
                    ? "Loading…"
                    : `${audit?.length ?? 0} most recent action${audit?.length === 1 ? "" : "s"}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAuditOpen(false)}
                aria-label="Close"
                className="flex size-[36px] shrink-0 items-center justify-center rounded-full text-[20px] leading-none text-[#cfcdcd] transition-colors hover:text-white"
              >
                ✕
              </button>
            </div>

            {auditLoading && !audit ? (
              <p className="py-[20px] font-[family-name:var(--font-sora)] text-[14px] text-[#bab6b6]">
                Loading…
              </p>
            ) : !audit || audit.length === 0 ? (
              <p className="py-[20px] font-[family-name:var(--font-sora)] text-[14px] text-[#bab6b6]">
                Nothing recorded yet.
              </p>
            ) : (
              // Full width here, so the order id shows complete rather than
              // truncating — it's the value you need in order to act on it.
              <div
                data-lenis-prevent
                className="flex min-h-0 flex-col overflow-y-auto overscroll-contain"
              >
                <div
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}
                  className={`sticky top-0 grid ${LOG_COLS} gap-x-[16px] bg-[#1e1c1c] pb-[10px]`}
                >
                  {["When", "Who", "Action", "Outcome", "Order"].map((h) => (
                    <span
                      key={h}
                      className="font-[family-name:var(--font-sora)] text-[12px] uppercase tracking-[0.06em] text-[#8d8c8c]"
                    >
                      {h}
                    </span>
                  ))}
                </div>
                <ul className="flex flex-col">
                  {audit.map((e, i) => (
                    <li
                      key={`${e.at}-${i}`}
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                      className={`grid ${LOG_COLS} items-baseline gap-x-[16px] py-[12px] font-[family-name:var(--font-sora)] text-[13px] leading-[20px]`}
                    >
                      <span className="text-[#a19d9d]">
                        {new Date(e.at).toLocaleString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="truncate text-white">{e.operator}</span>
                      <span className="text-[#d6d3d3]">{e.action}</span>
                      <span style={{ color: e.outcome === "error" ? "#ca4c4c" : "#c9a962" }}>
                        {e.outcome}
                      </span>
                      <span className="break-all font-[family-name:var(--font-inter)] text-[12px] text-[#8d8c8c]">
                        {e.orderId}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="font-[family-name:var(--font-sora)] text-[12px] leading-[18px] text-[#8d8c8c]">
              Names are self-reported. A shared password can&apos;t prove who was
              typing, so treat these as a record of what happened, not proof of
              who did it.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <span className="font-[family-name:var(--font-sora)] text-[12px] text-[#8d8c8c]">
        {label}
      </span>
      <span className="font-[family-name:var(--font-sora)] text-[15px] text-white">
        {value}
      </span>
    </div>
  );
}
