import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  SOLANA_CONFIG,
  SOLANA_USDC_DECIMALS,
  isSolanaEnabled,
  requireSolanaRpcUrl,
} from "@/lib/solana/config";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";

export const maxDuration = 20;

// Base fee (5k lamports) + our priority fee (~15k) + rent for the MessageSent
// event account (~0.0016 SOL, reclaimable later but needed upfront) + buffer.
const SOL_GAS_FLOOR_LAMPORTS = Math.round(0.005 * LAMPORTS_PER_SOL);

/**
 * The connected Solana wallet's USDC + SOL balances, for the header readout,
 * FormCard's USDC check, and the SOL-for-gas gate. Read-only, server RPC —
 * mirrors evm-balances / evm-gas-preflight.
 */
export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get("address") || "";
    let owner: PublicKey;
    try {
      owner = new PublicKey(address);
    } catch {
      return NextResponse.json({ error: "Invalid Solana wallet address" }, { status: 400 });
    }
    if (!isSolanaEnabled()) {
      return NextResponse.json(
        { error: "Solana is not currently enabled as a source chain" },
        { status: 400 },
      );
    }

    const rpcUrl = requireSolanaRpcUrl();

    const result = await withRetry(async () => {
      const connection = new Connection(rpcUrl, "confirmed");
      const usdcMint = new PublicKey(SOLANA_CONFIG.usdcMint);
      const ata = getAssociatedTokenAddressSync(usdcMint, owner);

      const [lamports, usdcAtomic] = await Promise.all([
        connection.getBalance(owner),
        getAccount(connection, ata).then(
          (a) => a.amount,
          () => BigInt(0), // no token account yet ⇒ 0 USDC
        ),
      ]);

      const usdcDivisor = BigInt(10) ** BigInt(SOLANA_USDC_DECIMALS);
      const usdcWhole = usdcAtomic / usdcDivisor;
      const usdcFrac = (usdcAtomic % usdcDivisor)
        .toString()
        .padStart(SOLANA_USDC_DECIMALS, "0")
        .replace(/0+$/, "");

      return {
        usdc: usdcFrac ? `${usdcWhole}.${usdcFrac}` : usdcWhole.toString(),
        sol: (lamports / LAMPORTS_PER_SOL).toString(),
        nativeCurrencySymbol: "SOL",
        sufficientForGas: lamports >= SOL_GAS_FLOOR_LAMPORTS,
      };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the Solana network right now."
      : msg || "Failed to fetch balances";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
