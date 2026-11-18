import { NextRequest, NextResponse } from "next/server";
import { BuildTxError, buildSourceTx, type PermitSig } from "@/lib/bridge/build-source-tx";
import type { QuoteResponse } from "@/lib/bridge/build-quote";
import { CCTP_CONFIG } from "@/lib/cctp/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const UNAVAILABLE = "Couldn't prepare the transaction right now — try again in a moment";

/**
 * POST /api/bridge/build-tx — the unsigned source-chain transaction for a
 * signed quote. Body: { quote: QuoteResponse, userAddress, permit? }.
 *
 * 200 SourceTx: { family: "evm", chainId, to, data, value, needsApproval } | { family: "stellar", xdr }
 *     | { family: "solana", txBase64 } (v0, event keypair already signed; the wallet signs + sends)
 * 400 { error, code }: invalid_request / invalid_quote / quote_expired /
 *     contract_mismatch / wrong_user / invalid_permit / simulation_failed
 * 503 { error, code: "unavailable" }: config or RPC failure.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Invalid request.", code: "invalid_request" },
      { status: 400, headers: NO_STORE },
    );
  }
  const b = body as Record<string, unknown>;

  try {
    // Every field is re-validated by buildSourceTx.
    const tx = await buildSourceTx(b.quote as QuoteResponse, b.userAddress as string, {
      permit: b.permit === undefined || b.permit === null ? undefined : (b.permit as PermitSig),
    });
    // Stellar wallets must sign for the network the tx was built for (testnet on testnet).
    const body =
      tx.family === "stellar" ? { ...tx, networkPassphrase: CCTP_CONFIG.stellarNetworkPassphrase } : tx;
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof BuildTxError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400, headers: NO_STORE });
    }
    // Message only — never the stack or any key material.
    console.error(
      "[bridge/build-tx] failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : "unknown error",
    );
    return NextResponse.json(
      { error: UNAVAILABLE, code: "unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
