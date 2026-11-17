/**
 * The user's USDC balance on a bridge source chain, for the From card's
 * "Balance" line and Max button. Testnet-aware through BRIDGE_CHAINS and
 * CCTP_NETWORK, unlike the offramp's balance routes (mainnet addresses).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { CCTP_NETWORK } from "../cctp/constants";
import { requireSolanaRpcUrl } from "../solana/config";
import { fetchHorizonAccount, type HorizonBalance } from "./address-live";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

/** Circle's USDC issuer on Stellar (developers.circle.com/stablecoins/usdc-contract-addresses.md). */
export const STELLAR_USDC_ISSUER =
  CCTP_NETWORK === "testnet"
    ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export interface UsdcBalance {
  /** Atomic units as a decimal string. */
  atomic: string;
  decimals: 6 | 7;
}

export interface UsdcBalanceDeps {
  evmBalanceOf(chain: BridgeChainKey, token: string, owner: string): Promise<bigint>;
  /** Horizon balances, or null when the account doesn't exist. */
  stellarBalances(account: string): Promise<HorizonBalance[] | null>;
  /** Raw amounts of every token account `owner` holds for `mint`. */
  solanaTokenAmounts(owner: string, mint: string): Promise<bigint[]>;
}

/** "25.5" → 255000000 at 7 decimals. */
function toAtomic(decimal: string, decimals: number): bigint {
  const [i, f = ""] = decimal.split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
}

export async function readUsdcBalance(
  chain: BridgeChainKey,
  owner: string,
  deps: UsdcBalanceDeps = defaultUsdcBalanceDeps(),
): Promise<UsdcBalance> {
  const c = BRIDGE_CHAINS[chain];
  switch (c.family) {
    case "evm": {
      const v = await deps.evmBalanceOf(chain, c.usdc, owner);
      return { atomic: v.toString(), decimals: 6 };
    }
    case "stellar": {
      const balances = await deps.stellarBalances(owner);
      const line = balances?.find(
        (b) => b.asset_code === "USDC" && b.asset_issuer === STELLAR_USDC_ISSUER,
      );
      return { atomic: line?.balance ? toAtomic(line.balance, 7).toString() : "0", decimals: 7 };
    }
    case "solana": {
      const amounts = await deps.solanaTokenAmounts(owner, c.usdc);
      return { atomic: amounts.reduce((a, b) => a + b, BigInt(0)).toString(), decimals: 6 };
    }
  }
}

const RPC_TIMEOUT_MS = 10_000;

export function defaultUsdcBalanceDeps(): UsdcBalanceDeps {
  return {
    async evmBalanceOf(chain, token, owner) {
      const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
      const rpc = process.env[envVar];
      if (!rpc) throw new Error(`${envVar} is not set`);
      const client = createPublicClient({ transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
      return client.readContract({
        address: token as Hex,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Hex],
      });
    },
    async stellarBalances(account) {
      const acct = await fetchHorizonAccount(account);
      return acct ? acct.balances : null;
    },
    async solanaTokenAmounts(owner, mint) {
      const conn = new Connection(requireSolanaRpcUrl(), "confirmed");
      const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), {
        mint: new PublicKey(mint),
      });
      return res.value.map((a) => BigInt(a.account.data.parsed.info.tokenAmount.amount as string));
    },
  };
}
