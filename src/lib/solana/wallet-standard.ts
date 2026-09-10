/**
 * Wallet Standard discovery for Solana browser wallets (Phantom, Solflare,
 * Backpack, …) — the Solana counterpart to `cctp/../evm/injected.ts`'s
 * EIP-6963 discovery. We use `@wallet-standard/app`'s registry primitive
 * (not the React-context-heavy `@solana/wallet-adapter-react`) and keep the
 * connect / sign logic in `useSolanaWallet`.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

export const StandardConnect = "standard:connect";
export const StandardDisconnect = "standard:disconnect";
export const SolanaSignAndSendTransaction = "solana:signAndSendTransaction";
export const SolanaSignTransaction = "solana:signTransaction";
export const SolanaSignMessage = "solana:signMessage";

export interface SolanaWalletEntry {
  name: string;
  icon: string;
  wallet: Wallet;
}

function isUsableSolanaWallet(w: Wallet): boolean {
  const f = w.features as Record<string, unknown>;
  const canConnect = StandardConnect in f;
  const canSign =
    SolanaSignAndSendTransaction in f || SolanaSignTransaction in f;
  const supportsSolana = w.chains.some((c) => c.startsWith("solana:"));
  return canConnect && canSign && supportsSolana;
}

function toEntry(w: Wallet): SolanaWalletEntry {
  return { name: w.name, icon: w.icon, wallet: w };
}

/**
 * Calls `onChange` immediately and whenever a wallet registers/unregisters.
 * Returns an unsubscribe. Wallets can register at any time (some are slow),
 * so this stays subscribed rather than probing once.
 */
export function subscribeSolanaWallets(
  onChange: (wallets: SolanaWalletEntry[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const { get, on } = getWallets();
  const emit = () => onChange(get().filter(isUsableSolanaWallet).map(toEntry));
  emit();
  const offRegister = on("register", emit);
  const offUnregister = on("unregister", emit);
  return () => {
    offRegister();
    offUnregister();
  };
}

/** The first `solana:` chain the account supports (for signAndSendTransaction). */
export function accountSolanaChain(account: WalletAccount): string {
  return (
    account.chains.find((c) => c.startsWith("solana:")) ?? "solana:mainnet"
  );
}
