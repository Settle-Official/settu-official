"use client";

/**
 * Admin console "Bridge" section: fee settings, the owner-signed on-chain
 * limits panel (spec §5), recent bridges with Revive, relayer balances.
 *
 * Owner transactions are built server-side UNSIGNED and signed here by the
 * owner's own wallet (EVM via useEvmWallet, Stellar via the wallet adapter).
 * The server never holds an owner key.
 *
 * Structural types only: this client component must not import server
 * modules (the chain registry reads server env).
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EvmConnectModal } from "@/components/EvmConnectModal";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import {
  connectWallet as connectStellarWallet,
  signTransaction as signStellarTransaction,
} from "@/lib/stellar/wallet-adapter";
import {
  bpsToPercent,
  formatAtomic,
  limitDecimals,
  parseAtomic,
  percentToBps,
} from "@/lib/bridge/admin-units";

// Same look as AdminRecoveryConsole.
const CARD =
  "rounded-[20px] border border-white/15 bg-white/[0.04] p-[24px] max-[700px]:p-[16px]";
const FIELD =
  "h-[44px] rounded-[14px] bg-transparent px-[14px] font-[family-name:var(--font-sora)] text-[14px] text-white outline-none placeholder:text-[#8d8c8c]";
const BORDER = { border: "1px solid rgba(255,255,255,0.14)" };
const GOLD = { backgroundColor: "#c9a962" };
const PRIMARY =
  "h-[44px] rounded-[40px] px-[22px] font-[family-name:var(--font-sora)] text-[14px] font-medium text-[#1a1a1a] disabled:opacity-50";
const GHOST =
  "h-[40px] rounded-[14px] px-[16px] font-[family-name:var(--font-sora)] text-[14px] text-[#e6e3e3] disabled:opacity-50";
const H2 = "font-fraunces text-[22px] text-white";
const TEXT = "font-[family-name:var(--font-sora)] text-[14px] leading-[20px] text-[#d6d3d3]";
const MUTED = "font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#8d8c8c]";
const RED = "#CA4C4C";
const AMBER = "#AE9611";
const GREEN = "#109F21";
const GREY = "#8D8C8C";

type Family = "evm" | "stellar" | "solana";
type Limit = "maxFeeBps" | "maxNetworkFee" | "maxNativeFee";

interface FeeAudit {
  at: string;
  actor: string;
  speed: "standard" | "fast";
  from: number;
  to: number;
}
interface FeeState {
  standardBps: number;
  fastBps: number;
  audit: FeeAudit[];
  lowestCapBps: number | null;
  capSource: "chain" | "env" | "unavailable";
}
interface CapRow {
  chain: string;
  label: string;
  family: Family;
  nativeSymbol?: string;
  status: "ok" | "not_deployed" | "not_available" | "error";
  maxFeeBps?: string;
  maxNetworkFee?: string;
  maxNativeFee?: string;
  message?: string;
  error?: string;
}
interface CapsState {
  chains: CapRow[];
  fee: { standardBps: number; fastBps: number };
  lowestCapBps: number | null;
}
interface BridgeRow {
  id: string;
  status: string;
  recordStatus: string;
  source: string;
  dest: string;
  sendAtomic: string;
  speed: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
  destTx?: string;
}
interface RelayerRow {
  chain: string;
  label: string;
  symbol: string;
  decimals: number;
  status: "ok" | "not_configured" | "error";
  address?: string;
  balanceAtomic?: string;
}
type OwnerTx =
  | { family: "evm"; chainId: number; to: `0x${string}`; data: `0x${string}` }
  | { family: "stellar"; xdr: string; networkPassphrase: string };

/** "pending" | "signing" | sent hash | error message, per chain. */
type Step = { state: "signing" } | { state: "sent"; hash: string } | { state: "error"; message: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload as T;
}

const STATUS_COLOR: Record<string, string> = {
  completed: GREEN,
  failed: RED,
  submitted: AMBER,
  verifying: AMBER,
  delivering: AMBER,
};

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const when = (ms: number | string) =>
  new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export type BridgeAdminSection = "fee" | "limits" | "bridges" | "relayers";
const ALL_SECTIONS: readonly BridgeAdminSection[] = ["fee", "limits", "bridges", "relayers"];

export function BridgeAdminPanel({
  operator,
  sections = ALL_SECTIONS,
  title = "Bridge",
}: {
  readonly operator: string;
  /** Which parts to show (and load): settings on /admin/bridge/settings, status on /admin/bridge. */
  readonly sections?: readonly BridgeAdminSection[];
  readonly title?: string;
}) {
  const has = (s: BridgeAdminSection) => sections.includes(s);
  const named = operator.trim().length > 1;
  const evm = useEvmWallet();

  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------- fee
  const [fee, setFee] = useState<FeeState | null>(null);
  const [feeInput, setFeeInput] = useState({ standard: "", fast: "" });
  const [savingFee, setSavingFee] = useState<string | null>(null);

  const loadFee = useCallback(async () => {
    try {
      const f = await api<FeeState>("/api/admin/bridge/fee");
      setFee(f);
      setFeeInput({ standard: bpsToPercent(f.standardBps), fast: bpsToPercent(f.fastBps) });
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const saveFee = async (speed: "standard" | "fast") => {
    setError(null);
    if (!named) return setError("Enter your name at the top first — every action is attributed.");
    const parsed = percentToBps(feeInput[speed]);
    if (!parsed.ok) return setError(parsed.error);
    setSavingFee(speed);
    try {
      await api("/api/admin/bridge/fee", {
        method: "PUT",
        body: JSON.stringify({ speed, feeBps: parsed.bps, operator }),
      });
      await Promise.all([loadFee(), loadCaps()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingFee(null);
    }
  };

  // ---------------------------------------------------------------- caps
  const [caps, setCaps] = useState<CapsState | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);
  const [newCap, setNewCap] = useState("");
  const [target, setTarget] = useState<number | null>(null);
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const [signing, setSigning] = useState<Family | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [limitEdit, setLimitEdit] = useState<{ limit: "maxNetworkFee" | "maxNativeFee"; value: string }>({
    limit: "maxNetworkFee",
    value: "",
  });

  const loadCaps = useCallback(async () => {
    setCapsLoading(true);
    try {
      setCaps(await api<CapsState>("/api/admin/bridge/caps"));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCapsLoading(false);
    }
  }, []);

  const highestFee = caps ? Math.max(caps.fee.standardBps, caps.fee.fastBps) : 0;

  /** Build → sign in the owner wallet → submit. Returns the tx hash. */
  const signOne = async (row: CapRow, limit: Limit, value: bigint, owner: string): Promise<string> => {
    const tx = await api<OwnerTx>("/api/admin/bridge/caps", {
      method: "POST",
      body: JSON.stringify({ chain: row.chain, limit, value: value.toString(), ownerAddress: owner, operator }),
    });
    if (tx.family === "evm") {
      await evm.switchChain(tx.chainId);
      const [hash] = await evm.signAndSendCalls([{ to: tx.to, data: tx.data }], tx.chainId);
      return hash;
    }
    // Sign for the network the server built it for (testnet on testnet).
    const signedXdr = await signStellarTransaction(tx.xdr, owner, tx.networkPassphrase);
    const sent = await api<{ hash: string }>("/api/admin/bridge/caps/submit", {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    });
    return sent.hash;
  };

  /** The owner address for a family, connecting the wallet first if needed. */
  const ownerFor = async (family: Family): Promise<string | null> => {
    if (family === "evm") {
      if (evm.address) return evm.address;
      void evm.openConnect();
      setError("Connect the owner's EVM wallet, then press the button again.");
      return null;
    }
    if (family === "stellar") return (await connectStellarWallet()).publicKey;
    return null;
  };

  const signFamily = async (family: Family) => {
    setError(null);
    if (!caps) return;
    if (!named) return setError("Enter your name at the top first — every action is attributed.");
    const parsed = percentToBps(newCap);
    if (!parsed.ok) return setError(parsed.error);
    if (parsed.bps < highestFee) return setError("Lower the bridge fee first");
    const rows = caps.chains.filter((c) => c.family === family && c.status === "ok");
    if (rows.length === 0) return setError(`No deployed ${family.toUpperCase()} contracts to update.`);

    setSigning(family);
    try {
      const owner = await ownerFor(family);
      if (!owner) return;
      setTarget(parsed.bps);
      // In sequence: one wallet prompt at a time, and a refusal stops the rest.
      for (const row of rows) {
        setSteps((s) => ({ ...s, [row.chain]: { state: "signing" } }));
        try {
          const hash = await signOne(row, "maxFeeBps", BigInt(parsed.bps), owner);
          setSteps((s) => ({ ...s, [row.chain]: { state: "sent", hash } }));
        } catch (err: any) {
          setSteps((s) => ({ ...s, [row.chain]: { state: "error", message: err?.message || "Failed" } }));
          break;
        }
      }
    } catch (err: any) {
      setError(err?.message || "Wallet connection failed");
    } finally {
      setSigning(null);
      // Give the transactions a moment to land, then re-read every chain.
      setTimeout(() => void loadCaps(), 8_000);
    }
  };

  const signLimit = async (row: CapRow) => {
    setError(null);
    if (!named) return setError("Enter your name at the top first — every action is attributed.");
    const parsed = parseAtomic(limitEdit.value, limitDecimals(row.family, limitEdit.limit));
    if (!parsed.ok) return setError(parsed.error);
    setSigning(row.family);
    try {
      const owner = await ownerFor(row.family);
      if (!owner) return;
      setSteps((s) => ({ ...s, [row.chain]: { state: "signing" } }));
      const hash = await signOne(row, limitEdit.limit, parsed.value, owner);
      setSteps((s) => ({ ...s, [row.chain]: { state: "sent", hash } }));
      setEditing(null);
      setTimeout(() => void loadCaps(), 8_000);
    } catch (err: any) {
      setSteps((s) => ({ ...s, [row.chain]: { state: "error", message: err?.message || "Failed" } }));
    } finally {
      setSigning(null);
    }
  };

  // ---------------------------------------------------------------- bridges
  const [bridges, setBridges] = useState<BridgeRow[] | null>(null);
  const [bridgeQuery, setBridgeQuery] = useState("");
  const [reviving, setReviving] = useState<string | null>(null);

  const loadBridges = useCallback(async (id?: string) => {
    try {
      const q = id?.trim() ? `?id=${encodeURIComponent(id.trim())}` : "";
      const r = await api<{ bridges: BridgeRow[] }>(`/api/admin/bridge/list${q}`);
      setBridges(r.bridges);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const revive = async (id: string) => {
    setError(null);
    if (!named) return setError("Enter your name at the top first — every action is attributed.");
    if (!window.confirm(`Revive bridge ${id}?\n\nThis resets the failed transfer and schedules delivery.`)) return;
    setReviving(id);
    try {
      await api("/api/admin/bridge/revive", { method: "POST", body: JSON.stringify({ id, operator }) });
      await loadBridges(bridgeQuery);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReviving(null);
    }
  };

  // ---------------------------------------------------------------- relayers
  const [relayers, setRelayers] = useState<RelayerRow[] | null>(null);
  const loadRelayers = useCallback(async () => {
    try {
      setRelayers((await api<{ relayers: RelayerRow[] }>("/api/admin/bridge/relayers")).relayers);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  // Only what this page shows. The fee card also reads the caps (its limit).
  const want = sections.join(",");
  useEffect(() => {
    if (want.includes("fee") || want.includes("limits")) void loadFee();
    if (want.includes("fee") || want.includes("limits")) void loadCaps();
    if (want.includes("bridges")) void loadBridges();
    if (want.includes("relayers")) void loadRelayers();
  }, [want, loadFee, loadCaps, loadBridges, loadRelayers]);

  // ---------------------------------------------------------------- render
  const deployed = (f: Family) => caps?.chains.filter((c) => c.family === f && c.status === "ok").length ?? 0;

  return (
    <section aria-labelledby="bridge-admin" className="flex flex-col gap-[20px]">
      <h2 id="bridge-admin" className="font-fraunces text-[26px] text-white">
        {title}
      </h2>

      {error && (
        <p role="alert" className={`${CARD} font-[family-name:var(--font-sora)] text-[14px] text-[#ca4c4c]`}>
          {error}
        </p>
      )}

      {/* Fee settings */}
      {has("fee") && (
      <div className={`${CARD} flex flex-col gap-[16px]`}>
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <h3 className={H2}>Bridge fee</h3>
          <span className={MUTED}>
            {fee?.lowestCapBps == null
              ? "Cap unavailable"
              : `Cap ${bpsToPercent(fee.lowestCapBps)}% (${fee.capSource === "env" ? "no contracts deployed — server limit" : "lowest on-chain"})`}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-[16px]">
          {(["standard", "fast"] as const).map((speed) => (
            <label key={speed} className="flex flex-col gap-[8px]">
              <span className={MUTED}>Bridge fee, {cap(speed)} (%)</span>
              <div className="flex gap-[10px]">
                <input
                  inputMode="decimal"
                  value={feeInput[speed]}
                  onChange={(e) => setFeeInput((f) => ({ ...f, [speed]: e.target.value }))}
                  style={BORDER}
                  className={`${FIELD} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  onClick={() => saveFee(speed)}
                  disabled={!fee || savingFee !== null || !named}
                  title={named ? undefined : "Enter your name at the top first"}
                  style={GOLD}
                  className={PRIMARY}
                >
                  {savingFee === speed ? "Saving…" : "Save"}
                </button>
              </div>
            </label>
          ))}
        </div>
        {fee && fee.audit.length > 0 && (
          <ul className="flex flex-col">
            {fee.audit.slice(0, 5).map((a, i) => (
              <li
                key={`${a.at}-${i}`}
                style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                className={`${MUTED} flex flex-wrap gap-x-[14px] py-[6px]`}
              >
                <span>{when(a.at)}</span>
                <span className="text-white">{a.actor}</span>
                <span>
                  {cap(a.speed)}: {bpsToPercent(a.from)}% → {bpsToPercent(a.to)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      )}

      {/* On-chain limits */}
      {has("limits") && (
      <div className={`${CARD} flex flex-col gap-[16px]`}>
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <h3 className={H2}>On-chain limits</h3>
          <button type="button" onClick={() => void loadCaps()} disabled={capsLoading} style={BORDER} className={GHOST}>
            {capsLoading ? "Reading…" : "Re-read all"}
          </button>
        </div>
        <p className={MUTED}>
          Changed only by the owner wallet, signed here. Current fee is {bpsToPercent(highestFee)}% at its highest; a
          cap below that is refused.
        </p>

        <div className="flex flex-wrap items-end gap-[12px]">
          <label className="flex flex-col gap-[8px]">
            <span className={MUTED}>New fee cap (%)</span>
            <input
              inputMode="decimal"
              value={newCap}
              onChange={(e) => setNewCap(e.target.value)}
              placeholder="1"
              style={BORDER}
              className={`${FIELD} w-[140px]`}
            />
          </label>
          <button
            type="button"
            onClick={() => signFamily("evm")}
            disabled={!caps || signing !== null || !newCap.trim() || deployed("evm") === 0}
            style={GOLD}
            className={PRIMARY}
          >
            {signing === "evm" ? "Signing…" : `Sign on EVM (${deployed("evm")})`}
          </button>
          <button
            type="button"
            onClick={() => signFamily("stellar")}
            disabled={!caps || signing !== null || !newCap.trim() || deployed("stellar") === 0}
            style={GOLD}
            className={PRIMARY}
          >
            {signing === "stellar" ? "Signing…" : `Sign on Stellar (${deployed("stellar")})`}
          </button>
          {evm.address && <span className={MUTED}>EVM owner {short(evm.address)}</span>}
        </div>

        <div className="flex flex-col">
          {caps?.chains.map((row) => {
            const step = steps[row.chain];
            const differs = target !== null && row.status === "ok" && Number(row.maxFeeBps) !== target;
            const dot =
              row.status === "ok" ? (differs ? AMBER : GREEN) : row.status === "error" ? RED : GREY;
            return (
              <div
                key={row.chain}
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  ...(differs ? { backgroundColor: "rgba(174,150,17,0.08)" } : {}),
                }}
                className="flex flex-col gap-[8px] px-[4px] py-[12px]"
              >
                <div className="grid grid-cols-[minmax(110px,1fr)_repeat(3,minmax(90px,1fr))_auto] items-baseline gap-x-[12px] gap-y-[4px] max-[700px]:grid-cols-2">
                  <span className="flex items-center gap-[10px] font-[family-name:var(--font-sora)] text-[15px] text-white">
                    <span style={{ backgroundColor: dot }} className="size-[8px] shrink-0 rounded-full" />
                    {row.label}
                  </span>
                  {row.status === "ok" ? (
                    <>
                      <span className={TEXT}>
                        cap {bpsToPercent(Number(row.maxFeeBps))}%{differs ? " (not updated)" : ""}
                      </span>
                      <span className={TEXT}>
                        network {formatAtomic(row.maxNetworkFee!, limitDecimals(row.family, "maxNetworkFee"))} USDC
                      </span>
                      <span className={TEXT}>
                        native {formatAtomic(row.maxNativeFee!, limitDecimals(row.family, "maxNativeFee"))}{" "}
                        {row.nativeSymbol ?? ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditing(editing === row.chain ? null : row.chain)}
                        style={BORDER}
                        className={`${GHOST} h-[32px] px-[12px] text-[13px]`}
                      >
                        {editing === row.chain ? "Close" : "Limits"}
                      </button>
                    </>
                  ) : (
                    <span className={`${MUTED} col-span-4 max-[700px]:col-span-1`}>
                      {row.status === "not_deployed"
                        ? "Not deployed"
                        : row.status === "not_available"
                          ? (row.message ?? "Not available yet")
                          : (row.error ?? "Couldn't read")}
                    </span>
                  )}
                </div>
                {step && (
                  <span
                    className={MUTED}
                    style={{ color: step.state === "error" ? RED : step.state === "sent" ? "#c9a962" : undefined }}
                  >
                    {step.state === "signing"
                      ? "Waiting for the owner wallet…"
                      : step.state === "sent"
                        ? `Sent ${short(step.hash)}`
                        : step.message}
                  </span>
                )}
                {editing === row.chain && row.status === "ok" && (
                  <div className="flex flex-wrap items-center gap-[10px]">
                    <select
                      value={limitEdit.limit}
                      onChange={(e) =>
                        setLimitEdit((l) => ({ ...l, limit: e.target.value as "maxNetworkFee" | "maxNativeFee" }))
                      }
                      style={BORDER}
                      className={`${FIELD} bg-[#1e1c1c]`}
                    >
                      <option value="maxNetworkFee">Max network fee (USDC)</option>
                      <option value="maxNativeFee">Max native fee ({row.nativeSymbol ?? "native"})</option>
                    </select>
                    <input
                      inputMode="decimal"
                      value={limitEdit.value}
                      onChange={(e) => setLimitEdit((l) => ({ ...l, value: e.target.value }))}
                      placeholder={limitEdit.limit === "maxNativeFee" ? `New value (${row.nativeSymbol ?? "native"})` : "New value (USDC)"}
                      style={BORDER}
                      className={`${FIELD} w-[160px]`}
                    />
                    <button
                      type="button"
                      onClick={() => signLimit(row)}
                      disabled={signing !== null || !limitEdit.value.trim()}
                      style={GOLD}
                      className={PRIMARY}
                    >
                      Sign
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {!caps && <p className={MUTED}>{capsLoading ? "Reading…" : "Not loaded."}</p>}
        </div>
      </div>

      )}

      {/* Bridges */}
      {has("bridges") && (
      <div className={`${CARD} flex flex-col gap-[16px]`}>
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <h3 className={H2}>Bridges</h3>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void loadBridges(bridgeQuery);
            }}
            className="flex flex-wrap gap-[10px]"
          >
            <input
              value={bridgeQuery}
              onChange={(e) => setBridgeQuery(e.target.value)}
              placeholder="Source tx hash (blank for recent)"
              aria-label="Bridge source transaction hash"
              style={BORDER}
              className={`${FIELD} w-[300px] max-[700px]:w-full`}
            />
            <button type="submit" style={BORDER} className={GHOST}>
              {bridgeQuery.trim() ? "Look up" : "Refresh"}
            </button>
          </form>
        </div>
        {bridges?.length === 0 && <p className={MUTED}>No bridges found.</p>}
        <ul className="flex flex-col">
          {bridges?.map((b) => (
            <li
              key={b.id}
              style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
              className="flex flex-col gap-[6px] py-[12px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-[10px]">
                <div className="flex flex-wrap items-center gap-[12px]">
                  <span
                    style={{ backgroundColor: STATUS_COLOR[b.status] ?? GREY }}
                    className="size-[8px] shrink-0 rounded-full"
                  />
                  <span className="font-[family-name:var(--font-sora)] text-[15px] text-white">
                    {cap(b.source)} → {cap(b.dest)}
                  </span>
                  <span className={TEXT}>{formatAtomic(b.sendAtomic, 6)} USDC</span>
                  <span className={MUTED}>
                    {b.recordStatus} · {b.speed} · {when(b.createdAt)} · {b.attempts} attempt
                    {b.attempts === 1 ? "" : "s"}
                  </span>
                </div>
                {b.recordStatus === "failed" && (
                  <button
                    type="button"
                    onClick={() => revive(b.id)}
                    disabled={reviving !== null || !named}
                    title={named ? undefined : "Enter your name at the top first"}
                    style={GOLD}
                    className={PRIMARY}
                  >
                    {reviving === b.id ? "Reviving…" : "Revive"}
                  </button>
                )}
              </div>
              <code className="break-all font-[family-name:var(--font-inter)] text-[12px] text-[#8d8c8c]">{b.id}</code>
              {b.lastError && <span className={MUTED} style={{ color: RED }}>{b.lastError}</span>}
            </li>
          ))}
        </ul>
      </div>

      )}

      {/* Relayers */}
      {has("relayers") && (
      <div className={`${CARD} flex flex-col gap-[16px]`}>
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <h3 className={H2}>Relayer balances</h3>
          <button type="button" onClick={() => void loadRelayers()} style={BORDER} className={GHOST}>
            Refresh
          </button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[12px]">
          {relayers?.map((r) => (
            <div key={r.chain} className="flex flex-col gap-[4px]">
              <span className={MUTED}>{r.label}</span>
              <span
                className="font-[family-name:var(--font-sora)] text-[15px]"
                style={{ color: r.status === "ok" ? "#fff" : r.status === "error" ? RED : GREY }}
              >
                {r.status === "ok"
                  ? `${formatAtomic(r.balanceAtomic!, r.decimals)} ${r.symbol}`
                  : r.status === "error"
                    ? "Couldn't read"
                    : "Not configured"}
              </span>
              {r.address && (
                <code className="font-[family-name:var(--font-inter)] text-[12px] text-[#8d8c8c]">{short(r.address)}</code>
              )}
            </div>
          ))}
        </div>
      </div>

      )}

      <EvmConnectModal
        open={evm.isConnectModalOpen}
        injectedWallets={evm.injectedWallets}
        pairingUri={evm.pairingUri}
        isConnecting={evm.isConnecting}
        error={evm.error}
        onPickInjected={(rdns) => void evm.connectInjected(rdns)}
        onPickWalletConnect={() => void evm.connectWalletConnect()}
        onClose={evm.closeConnect}
      />
    </section>
  );
}
