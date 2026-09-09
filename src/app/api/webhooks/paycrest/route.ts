import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import {
  mapPaycrestStatus,
  normalizePayoutStatus,
} from "@/lib/offramp/adapters/paycrest-adapter";
import { setPayoutStatus, claimSettlementRecording } from "@/lib/offramp/payout-store";
import type { PayoutStatus, OnrampStatus } from "@/lib/offramp/types";
import { updateOnrampOrder, getOnrampOrder } from "@/lib/onramp/onramp-store";
import { handleOnrampSettled } from "@/lib/onramp/handle-settlement";
import { notify, alertOfframpEvent, alertRampEvent } from "@/lib/notify/telegram";
import { PLATFORM_FEE_RATE } from "@/lib/offramp/fiat-conversion";
import { getOrderMeta } from "@/lib/offramp/order-meta-store";
import { pushRecentTransaction, addVolume } from "@/lib/stats-store";
import { formatFiat } from "@/lib/format/currency";

// Needs Node's crypto and the raw request body; keep off the edge runtime.
export const runtime = "nodejs";
// Onramp `settled` triggers the Base→Stellar bridge inline (approve + broadcast).
// Give it room; the bridge lock prevents a retry from double-spending.
export const maxDuration = 60;


function verifyPaycrestSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch — treat that as "not equal".
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get("X-Paycrest-Signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const webhookSecret = process.env.PAYCREST_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // Config error, not the caller's fault — 500 so failures are visible.
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    // Read the RAW body before parsing — the HMAC is computed over these exact
    // bytes, so parsing first would break verification.
    const body = await request.text();

    if (!verifyPaycrestSignature(body, signature, webhookSecret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const { event, data } = JSON.parse(body) as {
      event?: string;
      data?: {
        id?: string;
        status?: string;
        amount?: string;
        txHash?: string;
        rate?: string;
        reference?: string;
        recipient?: {
          institution?: string;
          accountIdentifier?: string;
          accountName?: string;
          currency?: string;
        };
      };
    };

    const orderId = data?.id;
    if (!orderId) {
      // Verified but unusable — ack so Paycrest doesn't retry a malformed one.
      return NextResponse.json({ success: true, ignored: true });
    }

    // Route by direction. Paycrest's real webhook payload has no `direction`
    // field (despite the type below) — it's never populated, so relying on it
    // silently misroutes every onramp event into the offramp path below,
    // which never triggers the Base→Stellar bridge. Look up which store the
    // order actually lives in instead; that's the source of truth since we
    // wrote it ourselves at order-creation time.
    const onrampRecord = await getOnrampOrder(orderId);

    // Confirmation ping: every verified delivery lands here. Lets you see in
    // Telegram that webhooks are actually reaching the deployment.
    void notify(
      `📥 Webhook received: <code>${event ?? "?"}</code>` +
        ` · ${onrampRecord ? "onramp" : "offramp"} · order <code>${orderId}</code>`,
      "info",
    );

    // Prefer the bare status from the v2 payload; fall back to mapping the
    // event name when it's missing or unrecognised.
    const bare = normalizePayoutStatus(data?.status);
    const status: PayoutStatus =
      bare !== "unknown" ? bare : mapPaycrestStatus(event ?? "");

    // Onramp needs the custodial Base→Stellar bridge; the existing offramp
    // path just persists status for the client SSE stream.
    if (onrampRecord) {
      await updateOnrampOrder(orderId, {
        status: status as OnrampStatus,
        ...(data?.amount ? { baseUsdcAmount: data.amount } : {}),
      });

      // Rich alert on every onramp status change, enriched from the stored
      // record (refund account, rate) which the webhook payload lacks.
      const rec = await getOnrampOrder(orderId);
      void alertRampEvent({
        direction: "onramp",
        orderId,
        status,
        accountName: rec?.refundAccountName ?? data?.recipient?.accountName,
        accountNumber:
          rec?.refundAccountIdentifier ?? data?.recipient?.accountIdentifier,
        bank: rec?.refundInstitution ?? data?.recipient?.institution,
        currency: rec?.currency ?? data?.recipient?.currency,
        amountIn: rec?.fiatAmount,
        amountInUnit: rec?.currency,
        rate: rec?.rate ?? (data?.rate ? Number(data.rate) : undefined),
        payoutValue: data?.amount, // USDC delivered
        payoutUnit: "USDC",
        stellarAddress: rec?.userStellarAddress,
      });

      if (status === "settled") {
        // Bridge inline. handleOnrampSettled is lock-guarded and hold-and-alert
        // on failure, so it's safe under Paycrest's retries.
        await handleOnrampSettled(orderId, data?.amount, data?.txHash);
      }

      return NextResponse.json({ success: true });
    }

    // --- Offramp (existing behavior) ---
    const payoutRecord = await setPayoutStatus(orderId, {
      status,
      amount: data?.amount,
      txHash: data?.txHash,
      event,
    });

    // Rich alert on EVERY status change. Prefer metadata captured at order
    // creation; fall back to the fields Paycrest includes in the payload
    // (rate/recipient/reference) so orders created before this deploy — or any
    // with missing meta — still get full detail.
    const meta = await getOrderMeta(orderId);
    const rcpt = data?.recipient;
    const payloadAmount = data?.amount ? Number(data.amount) : undefined;
    const payloadRate = data?.rate ? Number(data.rate) : undefined;
    // Fallback for orders with no stored meta (created before the fee fix, or
    // an expired Redis key). Must apply the same 0.3% as the order route, or
    // this path silently reintroduces the gross figure.
    const payoutValue =
      meta?.payoutValue ??
      (payloadAmount !== undefined && payloadRate !== undefined
        ? Number(
            (payloadAmount * payloadRate * (1 - PLATFORM_FEE_RATE)).toFixed(2),
          )
        : undefined);

    // Record it in the live transactions feed here (not client-side) so it's
    // captured regardless of whether the user's tab was still open — mirrors
    // the onramp fix in finalize.ts. Fires on "validated" OR "fulfilled" —
    // whichever this deployment sees first — rather than "settled": both mean
    // the recipient's fiat has been confirmed delivered, while settled just
    // follows once the backend protocol releases escrowed stablecoins, which
    // has nothing to do with whether the recipient got paid. (Paycrest sends
    // no `fulfilled` webhook today, but the order-status route writes it back
    // to the payout store from the live API, and that write lands here too.)
    // Paycrest can deliver the same webhook more than once in close
    // succession, so claim it atomically (Redis SET NX) rather than a
    // read-then-check, which can race when two deliveries overlap and both
    // read "not yet recorded" before either writes.
    if (
      (status === "validated" || status === "fulfilled") &&
      (await claimSettlementRecording(orderId))
    ) {
      const usdcAmount = meta?.amountUsdc ?? payloadAmount;
      if (usdcAmount !== undefined && Number.isFinite(usdcAmount)) {
        // Paycrest doesn't always carry the on-chain hash on the validated
        // event itself; payoutRecord.txHash is the merged value from
        // whichever event first reported it (deposited usually has it).
        // Fall back to the order id so a real identifier is always shown
        // instead of a placeholder.
        const displayHash = payoutRecord.txHash || orderId;
        void pushRecentTransaction({
          txHash: `${displayHash.slice(0, 4)}...${displayHash.slice(-4)}`,
          usdc: usdcAmount.toFixed(2),
          naira: formatFiat(payoutValue, meta?.currency ?? rcpt?.currency),
          status: "COMPLETE",
          type: "offramp",
        });
        void addVolume(usdcAmount);
      }
    }

    void alertOfframpEvent({
      orderId,
      status,
      accountName: meta?.accountName ?? rcpt?.accountName,
      accountNumber: meta?.accountIdentifier ?? rcpt?.accountIdentifier,
      bank: meta?.institution ?? rcpt?.institution,
      currency: meta?.currency ?? rcpt?.currency,
      amountUsdc: meta?.amountUsdc ?? data?.amount,
      rate: meta?.rate ?? payloadRate,
      payoutValue,
      reference: meta?.reference ?? data?.reference,
    });

    // 2xx quickly so Paycrest marks the delivery successful.
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Webhook processing failed" },
      { status: 500 },
    );
  }
}
