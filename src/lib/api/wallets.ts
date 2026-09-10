import { api } from "./client";

// Matches the backend's chain_family enum.
export type ChainFamily = "stellar" | "evm" | "solana";

export interface LinkedWallet {
  id: string;
  chain_family: ChainFamily;
  address: string;
  earns_cashback: boolean;
  linked_at: string;
}

interface Challenge {
  nonce: string;
  challenge: string;
}

export async function listWallets(): Promise<LinkedWallet[]> {
  const { wallets } = await api<{ wallets: LinkedWallet[] }>("/wallets");
  return wallets;
}

// The server decides what gets signed; the client only relays it to the wallet.
export function requestChallenge(
  chainFamily: ChainFamily,
  address: string,
): Promise<Challenge> {
  return api<Challenge>("/wallets/challenge", {
    method: "POST",
    body: { chain_family: chainFamily, address },
  });
}

export function submitSignature(nonce: string, signature: string) {
  return api<{ id: string; address: string; earns_cashback: boolean }>(
    "/wallets/verify",
    { method: "POST", body: { nonce, signature } },
  );
}

export function unlinkWallet(id: string): Promise<void> {
  return api<void>(`/wallets/${id}`, { method: "DELETE" });
}

export const CHAIN_LABEL: Record<ChainFamily, string> = {
  stellar: "Stellar",
  evm: "EVM",
  solana: "Solana",
};

// Addresses are long enough to break layout; show the ends, which is what
// people actually compare against their wallet.
export function shortAddress(address: string): string {
  return address.length <= 16
    ? address
    : `${address.slice(0, 6)}...${address.slice(-6)}`;
}
