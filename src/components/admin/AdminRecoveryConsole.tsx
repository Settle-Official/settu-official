"use client";

import { useCallback, useState, type FormEvent } from "react";

/** Mirrors OrderDiagnosis on the server; kept structural to avoid importing
 *  server-only modules into the client bundle. */
interface Diagnosis {
  orderId: string;
  verdict: "stranded-burn" | "bridge-stalled" | "record-stale" | "no-burn" | "unknown" | "healthy";
  summary: string;
  recoverable: boolean;
  meta: { amountUsdc?: number; senderAddress?: string; sourceChain?: string; payoutValue?: number; currency?: string; createdAt?: number } | null;
  payoutStatus: string | null;
  record: { status?: string; destinationAmount?: string } | null;
  transfer: { status?: string } | null;
  onChainBurn: { txHash: string; amountAtomic: string } | null;
  lookupError: string | null;
  sweepWouldSkip: string | null;
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

export function AdminRecoveryConsole() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [operator, setOperator] = useState("");
  const [query, setQuery] = useState("");
  const [orders, setOrders] = useState<Diagnosis[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

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
    // These move real money, so the action is spelled out rather than
    // hidden behind a one-word confirm.
    if (
      !window.confirm(
        `Register the on-chain burn for order ${orderId}?\n\n` +
          `This mints the USDC to Paycrest and triggers the payout. It is safe to ` +
          `repeat, but it cannot be undone.`,
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
      // assuming it worked.
      const fresh: Diagnosis = payload.data.diagnosis;
      setOrders((prev) => prev?.map((o) => (o.orderId === orderId ? fresh : o)) ?? [fresh]);
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
            <p className="font-[family-name:var(--font-sora)] text-[13px] text-[#ca4c4c]">{error}</p>
          )}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1100px] flex-col gap-[24px] p-[24px]">
      <header className="flex flex-wrap items-baseline justify-between gap-[12px]">
        <h1 className="font-fraunces text-[28px] text-white">Recovery console</h1>
        <input
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          placeholder="Your name (for the audit log)"
          style={{ border: "1px solid rgba(255,255,255,0.14)" }}
          className="h-[40px] w-[260px] rounded-[14px] bg-transparent px-[14px] font-[family-name:var(--font-sora)] text-[14px] text-white outline-none placeholder:text-[#8d8c8c]"
        />
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
                  disabled={acting === o.orderId}
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
    </main>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <span className="font-[family-name:var(--font-sora)] text-[12px] text-[#8d8c8c]">{label}</span>
      <span className="font-[family-name:var(--font-sora)] text-[15px] text-white">{value}</span>
    </div>
  );
}
