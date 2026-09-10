import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { sorobanRpc } from "@/lib/stellar/soroban-rpc";

// Allow up to 15s total; sorobanRpc fails over across endpoints within that.
export const maxDuration = 15;

/**
 * Submit a signed Soroban transaction directly to the Stellar Soroban RPC
 * (with endpoint failover — see @/lib/stellar/soroban-rpc).
 *
 * We parse the signed XDR with the project's @stellar/stellar-sdk v14 for
 * diagnostic logging, but we still submit the raw base64 string to the RPC
 * so there is zero risk of re-serialisation drift.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    );
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ */
/*  Route handler                                                      */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const signedXdr = String(body?.signedXdr || "");

    if (!signedXdr) {
      return NextResponse.json(
        { error: "signedXdr is required" },
        { status: 400 },
      );
    }

    
    // ---- Diagnostic: parse the signed tx to log auth expiration ----
    try {
      const NETWORK_PASSPHRASE =
        "Public Global Stellar Network ; September 2015";
      const parsed = StellarSdk.TransactionBuilder.fromXDR(
        signedXdr,
        NETWORK_PASSPHRASE,
      );
      if ("operations" in parsed) {
        for (const op of (parsed as StellarSdk.Transaction).operations) {
          if (op.type === "invokeHostFunction") {
            const ihfOp = op as StellarSdk.Operation.InvokeHostFunction;
            if (ihfOp.auth && ihfOp.auth.length > 0) {
              for (let i = 0; i < ihfOp.auth.length; i++) {
                const creds = ihfOp.auth[i].credentials();
                const credType = creds.switch().name;
                if (credType === "sorobanCredentialsAddress") {
                  const exp = creds.address().signatureExpirationLedger();
                                  } else {
                                  }
              }
            }
          }
        }
              }
    } catch (parseErr: any) {
          }

    // ---- 1. Send the raw signed XDR directly (no SDK re-serialisation) ----
    // Short per-endpoint timeout so a failover still fits inside maxDuration.
    const sendResult = await sorobanRpc(
      "sendTransaction",
      { transaction: signedXdr },
      { timeoutMs: 6_000 },
    );

    
    const hash: string | undefined = sendResult?.hash;
    const sendStatus: string = sendResult?.status || "UNKNOWN";

    // Log diagnostic info if present (Soroban RPC includes these on errors)
    if (sendResult?.errorResultXdr) {
          }
    if (sendResult?.diagnosticEventsXdr) {
          }

    // Reject ERROR and TRY_AGAIN_LATER statuses outright.
    if (sendStatus === "ERROR" || sendStatus === "TRY_AGAIN_LATER") {
      // Try to decode the error for a human-readable message
      let decodedError = "";
      if (sendResult?.errorResultXdr) {
        try {
          const txResult = StellarSdk.xdr.TransactionResult.fromXDR(
            sendResult.errorResultXdr,
            "base64",
          );
          decodedError = txResult.result().switch().name;
        } catch {
          // ignore decode failures
        }
      }
            return NextResponse.json(
        {
          error: `Soroban sendTransaction ${sendStatus}${decodedError ? `: ${decodedError}` : ""}`,
          details: sendResult,
        },
        { status: 400 },
      );
    }

    // DUPLICATE means the RPC already has this tx hash in its pool.
    // It may be processing or already confirmed — return the hash and let
    // the client poll tx-status to find the real outcome.
    if (sendStatus === "DUPLICATE") {
            return NextResponse.json({
        hash,
        status: "PENDING",
      });
    }

    if (!hash) {
      return NextResponse.json(
        {
          error: "Soroban submit did not return hash",
          details: sendResult,
        },
        { status: 500 },
      );
    }

    // ---- 2. If PENDING, return immediately with hash — client will poll ----
    //
    // On Vercel, serverless functions have a short timeout (10s hobby, 60s pro).
    // Instead of polling here for 90s, return the hash + PENDING status so the
    // client can poll a lightweight /tx-status endpoint.
    if (sendStatus === "PENDING") {
            return NextResponse.json({
        hash,
        status: "PENDING",
      });
    }

    // Already SUCCESS or some other terminal status
        return NextResponse.json({
      hash,
      status: sendStatus,
    });
  } catch (error: any) {
        return NextResponse.json(
      {
        error: error?.message || "Failed to submit Soroban transaction",
        details:
          process.env.NODE_ENV === "development" ? error?.stack : undefined,
      },
      { status: 500 },
    );
  }
}
