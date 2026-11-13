import { NextRequest } from "next/server";
import { getCctpTransfer, type CctpTransferRecord } from "@/lib/cctp/cctp-store";
import { advanceCctpTransfer } from "@/lib/cctp/advance";

export const runtime = "nodejs";
export const maxDuration = 60;

const POLL_MS = 3000;
const ADVANCE_MS = 8000; // CCTP Fast Transfer targets ~8-20s; check fairly eagerly

/**
 * Streams a CCTP offramp transfer's status to the browser, same pattern as
 * the existing onramp stream (src/app/api/onramp/stream/[orderId]/route.ts):
 * this open-tab path is what drives attest→mint promptly, since this
 * project's Vercel plan only runs cron once a day.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;

  // Nothing left to stream: answer 204, the one response that makes an
  // EventSource stop reconnecting for good. Closing the stream instead reads
  // to the browser as a dropped connection, and it reconnects every ~3s for
  // as long as the tab is open. That loop, from clients that never close their
  // EventSource, was ~95% of all function invocations (Nov 2026).
  //
  // An unknown id still streams: registration can land a moment after the
  // stream opens (it falls back to sendBeacon), and this stream is what drives
  // the transfer to mint. The client bounds that wait.
  const initial = await getCctpTransfer(transferId).catch(() => null);
  if (initial?.status === "completed" || initial?.status === "failed") {
    return new Response(null, { status: 204 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastSerialized = "";
      let lastAdvance = 0;

      const send = (record: CctpTransferRecord) => {
        const payload = {
          id: record.id,
          status: record.status,
          burnTxHash: record.burnTxHash,
          mintTxHash: record.mintTxHash,
          updatedAt: record.updatedAt,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
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
          const record = await getCctpTransfer(transferId);
          if (!record) return;

          if (
            (record.status === "burned" ||
              record.status === "attesting" ||
              record.status === "attested" ||
              record.status === "minting") &&
            Date.now() - lastAdvance > ADVANCE_MS
          ) {
            lastAdvance = Date.now();
            try {
              await advanceCctpTransfer(transferId);
            } catch {
              // Advance failed this round — retry next interval.
            }
          }

          const latest = (await getCctpTransfer(transferId)) ?? record;
          const serialized = JSON.stringify(latest);
          if (serialized !== lastSerialized) {
            lastSerialized = serialized;
            send(latest);
          }

          if (latest.status === "completed" || latest.status === "failed") {
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
