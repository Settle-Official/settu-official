import { NextRequest, NextResponse } from "next/server";
import { getCctpTransfer } from "@/lib/cctp/cctp-store";
import {
  initializeAllbridgeSdk,
  getAllbridgeTransferStatus,
} from "@/lib/offramp/adapters/allbridge-adapter";

export const maxDuration = 30;

/**
 * Poll the Base→Stellar onramp bridge leg's status by burn tx hash. Onramp
 * moved from Allbridge to direct CCTP (see base-bridge.ts); a CctpTransferRecord
 * is keyed by its own burn tx hash, so that's checked first. Falls back to
 * Allbridge only for a transfer that predates the cutover — this route
 * wasn't updated when everything else was, so it always 404'd on a CCTP-era
 * tx hash despite still being wired up.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ txHash: string }> },
) {
  try {
    const { txHash } = await params;

    const cctpTransfer = await getCctpTransfer(txHash);
    if (cctpTransfer) {
      return NextResponse.json({ data: cctpTransfer });
    }

    const sdk = await initializeAllbridgeSdk();
    const status = await getAllbridgeTransferStatus(sdk, "BAS", txHash);
    return NextResponse.json({ data: status });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to fetch bridge status" },
      { status: 500 },
    );
  }
}
