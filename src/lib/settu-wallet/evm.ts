// EVM keys from the same recovery phrase as Stellar and Solana. secp256k1
// rather than ed25519, so derivation comes from viem rather than ed25519-hd-key.

import { mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem";
import { isValidMnemonic, normalizeMnemonic } from "./mnemonic";

// viem's default is BIP-44's m/44'/60'/0'/0/0 — what MetaMask and every other
// EVM wallet shows as the first account.
export function accountFromMnemonic(phrase: string): HDAccount {
  const normalized = normalizeMnemonic(phrase);
  if (!isValidMnemonic(normalized)) {
    throw new Error("That recovery phrase isn't valid. Check the words again.");
  }
  return mnemonicToAccount(normalized);
}

/** Checksummed address; the same one MetaMask derives from this phrase. */
export function addressFromMnemonic(phrase: string): `0x${string}` {
  return accountFromMnemonic(phrase).address;
}

/** personal_sign over the challenge, which is what the API recovers against. */
export function signMessage(
  account: HDAccount,
  message: string,
): Promise<`0x${string}`> {
  return account.signMessage({ message });
}

// Gas is the user's own responsibility here, so "not enough" is an expected
// outcome that must say what to top up, not surface a raw revert.
export function explainEvmError(error: unknown, nativeSymbol: string): string {
  const raw = (error as { shortMessage?: string; message?: string })
    ?.shortMessage ??
    (error as Error)?.message ??
    "";

  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(raw)) {
    return `Not enough ${nativeSymbol} to cover gas. Send a little ${nativeSymbol} to this wallet and try again.`;
  }
  if (/user rejected|denied/i.test(raw)) return "You cancelled that request.";
  if (/nonce too low|already known|replacement/i.test(raw)) {
    return "That transaction was already submitted. Check your recent activity before retrying.";
  }
  if (/transfer amount exceeds balance/i.test(raw)) {
    return "Not enough USDC in this wallet for that amount.";
  }
  return raw || "The network rejected that transaction.";
}

/** Sends calls in order from the derived account, paying gas from its balance. */
export async function sendCalls(
  account: HDAccount,
  calls: { to: `0x${string}`; data: `0x${string}` }[],
  network: string,
  chainId: number,
): Promise<string[]> {
  const { createWalletClient, http, defineChain } = await import("viem");
  const transport = http(`/api/wallet/evm/rpc?network=${network}`);
  const chain = defineChain({
    id: chainId,
    name: network,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [`/api/wallet/evm/rpc?network=${network}`] } },
  });

  const client = createWalletClient({ account, chain, transport });
  const hashes: string[] = [];
  for (const call of calls) {
    // Sequential: each call's nonce depends on the previous one landing.
    hashes.push(await client.sendTransaction({ to: call.to, data: call.data }));
  }
  return hashes;
}
