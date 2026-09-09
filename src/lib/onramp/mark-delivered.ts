// The one place an onramp order becomes `delivered`.
//
// Three paths detect delivery — the Allbridge finalizer, the SSE stream's CCTP
// advance, and the Telegram status check — but only the first recorded stats,
// so CCTP-era deliveries never reached platform volume. Funnelling all three
// through here fixes that and gives cashback a single hook later.

import {
  getOnrampOrder,
  updateOnrampOrder,
  removePendingBridge,
  claimOnrampDeliveryRecording,
} from "./onramp-store";
import { notify } from "@/lib/notify/telegram";
import { pushRecentTransaction, addVolume } from "@/lib/stats-store";
import { formatFiat } from "@/lib/format/currency";

function shortHash(hash?: string): string {
  return hash ? `${hash.slice(0, 4)}...${hash.slice(-4)}` : "----...----";
}

export async function markOnrampDelivered(
  orderId: string,
  opts: { stellarTxHash?: string; deliveredUsdc?: string } = {},
): Promise<void> {
  const record = await getOnrampOrder(orderId);
  if (!record) return;

  // Terminal records are frozen by the store, so a repeat call is a no-op here.
  await updateOnrampOrder(orderId, {
    status: "delivered",
    stellarTxHash: opts.stellarTxHash,
  });
  await removePendingBridge(orderId);

  // Everything below is side effects that must fire exactly once per delivery.
  if (!(await claimOnrampDeliveryRecording(orderId))) return;

  const deliveredUsdc = opts.deliveredUsdc ?? record.baseUsdcAmount;
  const usdcNum = parseFloat(deliveredUsdc ?? "");

  void notify(
    `Onramp <code>${orderId}</code> delivered to Stellar ✓` +
      (deliveredUsdc ? ` (${deliveredUsdc} USDC)` : ""),
    "success",
  );

  void pushRecentTransaction({
    txHash: shortHash(opts.stellarTxHash),
    usdc: Number.isFinite(usdcNum) ? usdcNum.toFixed(2) : "--",
    naira: formatFiat(record.fiatAmount, record.currency),
    status: "COMPLETE",
    type: "onramp",
  });
  if (Number.isFinite(usdcNum)) void addVolume(usdcNum);
}
