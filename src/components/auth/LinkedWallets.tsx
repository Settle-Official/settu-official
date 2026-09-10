"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import {
  CHAIN_LABEL,
  listWallets,
  requestChallenge,
  shortAddress,
  submitSignature,
  unlinkWallet,
  type ChainFamily,
  type LinkedWallet,
} from "@/lib/api/wallets";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useSolanaWallet } from "@/hooks/useSolanaWallet";

export function LinkedWallets({ emailVerified }: { readonly emailVerified: boolean }) {
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<ChainFamily | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stellar = useStellarWallet();
  const evm = useEvmWallet();
  const solana = useSolanaWallet();

  const refresh = useCallback(async () => {
    try {
      setWallets(await listWallets());
    } catch {
      setWallets([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // One flow for all three chains: ask the server for a challenge, have the
  // wallet sign it, send the signature back. Only the signing call differs.
  async function link(chain: ChainFamily) {
    setError(null);
    setBusy(chain);
    try {
      const address =
        chain === "stellar"
          ? stellar.wallet?.publicKey
          : chain === "evm"
            ? evm.address
            : solana.address;

      if (!address) {
        throw new Error(`Connect a ${CHAIN_LABEL[chain]} wallet first.`);
      }

      const { nonce, challenge } = await requestChallenge(chain, address);
      const signature =
        chain === "stellar"
          ? await stellar.signTransaction(challenge)
          : chain === "evm"
            ? await evm.signMessage(challenge)
            : await solana.signMessage(challenge);

      await submitSignature(nonce, signature);
      await refresh();
    } catch (err: any) {
      const message =
        err instanceof ApiError ? err.message : err?.message || "Couldn't link that wallet";
      // Declining in the wallet is a normal action, not an error worth showing.
      if (!/reject|denied|cancel|closed|dismiss/i.test(message)) setError(message);
    } finally {
      setBusy(null);
    }
  }

  async function unlink(id: string) {
    setError(null);
    try {
      await unlinkWallet(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't unlink that wallet");
    }
  }

  const chains: ChainFamily[] = ["stellar", "evm", "solana"];

  return (
    <div className="flex flex-col gap-[0.9rem]">
      <div>
        <h2 className="m-0 font-space-grotesk text-[1.13rem] font-bold">LINKED WALLETS</h2>
        <p className="mt-[0.3rem] mb-0 text-[0.72rem] text-[var(--muted)]">
          Only Stellar wallets earn cashback.
        </p>
      </div>

      {isLoading ? (
        <p className="m-0 text-[0.75rem] text-[var(--muted)]">Loading...</p>
      ) : wallets.length === 0 ? (
        <p className="m-0 text-[0.75rem] text-[var(--muted)]">No wallets linked yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[0.4rem] p-0">
          {wallets.map((wallet) => (
            <li
              key={wallet.id}
              className="flex items-center justify-between gap-3 border border-[var(--line)] px-[0.8rem] py-[0.6rem]"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-space-grotesk text-[0.8rem]">
                  {CHAIN_LABEL[wallet.chain_family]}
                  {wallet.earns_cashback && (
                    <span className="ml-2 text-[0.6rem] uppercase tracking-[0.06em] text-[var(--accent)]">
                      earns cashback
                    </span>
                  )}
                </span>
                <span className="truncate font-mono text-[0.7rem] text-[var(--muted)]">
                  {shortAddress(wallet.address)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => unlink(wallet.id)}
                className="flex-shrink-0 text-[0.65rem] uppercase tracking-[0.06em] text-[var(--muted)] hover:text-red-400"
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="m-0 text-[0.72rem] text-red-400">{error}</p>}

      {emailVerified ? (
        <div className="flex flex-wrap gap-2">
          {chains.map((chain) => (
            <button
              key={chain}
              type="button"
              disabled={busy !== null}
              onClick={() => link(chain)}
              // Inline style: the global unlayered `button` reset beats
              // Tailwind's layered utilities, as the mode switcher documents.
              style={{
                border: "1px solid #C9A962",
                color: busy === chain ? "#777777" : "#C9A962",
              }}
              className="px-3 py-2 text-[0.68rem] uppercase tracking-[0.06em] disabled:cursor-not-allowed"
            >
              {busy === chain ? "Signing..." : `Link ${CHAIN_LABEL[chain]}`}
            </button>
          ))}
        </div>
      ) : (
        <p className="m-0 text-[0.72rem] text-[var(--accent)]">
          Verify your email before linking a wallet.
        </p>
      )}
    </div>
  );
}
