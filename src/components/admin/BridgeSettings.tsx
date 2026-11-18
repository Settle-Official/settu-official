"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AdminNav } from "./AdminNav";
import { BridgeAdminPanel } from "./BridgeAdminPanel";

const CARD = "rounded-[20px] border border-white/15 bg-white/[0.04] p-[24px] max-[700px]:p-[16px]";
const FIELD =
  "w-full rounded-[12px] bg-transparent px-[14px] font-[family-name:var(--font-sora)] text-[14px] text-white outline-none";
const BORDER = { border: "1px solid rgba(255,255,255,0.14)" };
const GOLD = { backgroundColor: "#c9a962" };
const PRIMARY =
  "h-[48px] rounded-full px-[20px] font-[family-name:var(--font-sora)] text-[15px] text-[#141212] disabled:opacity-50";
const TEXT = "font-[family-name:var(--font-sora)] text-[14px] leading-[20px] text-[#d6d3d3]";

/**
 * /admin/bridge/settings: the bridge fee and the on-chain limits. Same
 * password gate as the other admin pages; every change is attributed to the
 * operator name entered here.
 */
export function BridgeSettings() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [operator, setOperator] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authed !== null) return;
    let cancelled = false;
    fetch("/api/admin/bridge/fee", { cache: "no-store" })
      .then((r) => !cancelled && setAuthed(r.status !== 401))
      .catch(() => !cancelled && setAuthed(true)); // let the panel report a real failure
    return () => {
      cancelled = true;
    };
  }, [authed]);

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
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "Login failed");
      setPassword("");
      setAuthed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  if (authed === false) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-[20px] p-[24px]">
        <h1 className="font-fraunces text-[28px] text-white">Bridge settings</h1>
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
    <main className="mx-auto flex min-h-screen w-full max-w-[1100px] flex-col gap-[24px] p-[24px] max-[700px]:p-[16px]">
      <header className="flex flex-wrap items-center justify-between gap-[12px]">
        <h1 className="font-fraunces text-[28px] text-white">Bridge settings</h1>
        <AdminNav />
      </header>
      <label className={`${CARD} flex flex-col gap-[8px]`}>
        <span className={TEXT}>Your name (every change is attributed)</span>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="e.g. Michael" style={BORDER} className={`${FIELD} h-[48px]`} />
      </label>
      {authed && <BridgeAdminPanel operator={operator} sections={["fee", "limits"]} title="Fee and limits" />}
    </main>
  );
}
