import { NextRequest } from "next/server";
import {
  getOnrampOrder,
  updateOnrampOrder,
  isTerminal,
  type OnrampRecord,
} from "@/lib/onramp/onramp-store";
import { getCctpTransfer } from "@/lib/cctp/cctp-store";
import { advanceCctpTransfer } from "@/lib/cctp/advance";
import { markOnrampDelivered } from "@/lib/onramp/mark-delivered";
import { alertManualAction } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const maxDuration = 60;

const POLL_MS = 3000;
// Check the CCTP transfer at most this often while bridging. Much slower
// than the Redis read so we don't hammer Iris/RPCs too eagerly.
const BRIDGE_CHECK_MS = 15000;

/**
 * Streams onramp order status to the browser. Reads the Redis record (written
 * by the order route, webhook, and bridge handler) and pushes on change.
 *
 * While the order is `bridging`, this also drives delivery confirmation: it
 * advances the order's CCTP transfer (attest → mint-and-forward on Stellar)
 * on a slow cadence. On Vercel Hobby the cron only runs daily, so this
 * open-tab path is what confirms delivery promptly. advanceCctpTransfer is
 * idempotent and shared with the cron sweep, so both racing is harmless.
 *
 * Closes on a terminal state (delivered / refunded / expired). EventSource
 * auto-reconnects across the Vercel timeout; each connect re-reads Redis, so no
 * state is lost. `bridge_failed` is streamed but not closed — resolution may
 * move it forward.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastSerialized = "";
      let lastBridgeCheck = 0;

      const send = (record: OnrampRecord) => {
        // Only surface fields the client needs; omit stored PII.
        const payload = {
          id: record.orderId,
          status: record.status,
          bridgeTxHash: record.bridgeTxHash,
          stellarTxHash: record.stellarTxHash,
          updatedAt: record.updatedAt,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", close);

      const tick = async () => {
        if (closed) return;
        try {
          const record = await getOnrampOrder(orderId);
          if (!record) return;

          // Drive delivery confirmation while bridging (throttled). advance
          // writes to the CCTP record; on completion this flips the onramp
          // order itself, and the next read below picks up the change.
          if (
            record.status === "bridging" &&
            record.cctpTransferId &&
            Date.now() - lastBridgeCheck > BRIDGE_CHECK_MS
          ) {
            lastBridgeCheck = Date.now();
            try {
              const cctpStatus = await advanceCctpTransfer(record.cctpTransferId);
              if (cctpStatus === "completed") {
                const transfer = await getCctpTransfer(record.cctpTransferId);
                await markOnrampDelivered(orderId, {
                  stellarTxHash: transfer?.mintTxHash,
                });
              } else if (cctpStatus === "failed") {
                await updateOnrampOrder(orderId, {
                  status: "bridge_failed",
                  failureReason: "CCTP transfer failed after max retries",
                });
                // This is the primary path that flips a transfer to failed
                // (the daily cron and manual checks are backstops), so this
                // is where the alert has to fire or nobody hears about it.
                // The burn already confirmed on-chain (that's the only way
                // this CctpTransferRecord exists) — alert with the revive
                // button, never the "new burn" one.
                void alertManualAction({
                  title: "Onramp bridge stuck after burn — mint never completed",
                  orderId,
                  amount: record.baseUsdcAmount,
                  currency: "USDC",
                  stellarAddress: record.userStellarAddress,
                  reason:
                    "CCTP transfer exhausted its retry budget after burning — safe to revive, don't retry-burn.",
                  cctpTransferId: record.cctpTransferId,
                });
              }
            } catch {
              // Advance failed this round — retry next interval.
            }
          }

          const latest = (await getOnrampOrder(orderId)) ?? record;
          const serialized = JSON.stringify(latest);
          if (serialized !== lastSerialized) {
            lastSerialized = serialized;
            send(latest);
          }

          if (isTerminal(latest.status)) {
            close();
          }
        } catch {
          // Transient error — keep the stream open, retry next tick.
        }
      };

      const interval = setInterval(tick, POLL_MS);
      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
