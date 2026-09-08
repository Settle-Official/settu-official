/**
 * Outbound-only Telegram alerts.
 *
 * Best-effort operational notifications for the offramp/onramp flows. Posts to
 * the Telegram Bot API; never throws, so a notification failure can't break a
 * payment or bridge path. Configure with:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — the chat/group id to send to
 */

type AlertLevel = "info" | "success" | "warning" | "critical";

const ICON: Record<AlertLevel, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  critical: "🚨",
};

interface InlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Attach this to any onramp alert to let the chat act on that order on
 * demand. The label is just wording — the callback handler (checkOnrampStatus)
 * already branches on the order's actual current status: re-checks Allbridge
 * if still bridging, retries the bridge if bridge_failed, or just reports
 * status otherwise. Same button, same handler; only the text changes to
 * match what it'll actually do in context.
 */
export function statusButton(
  orderId: string,
  label = "🔄 Check status",
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: label, callback_data: `status:${orderId}` }]],
  };
}

/**
 * Button for a bridge_failed onramp alert — same status:<orderId> callback
 * as statusButton (checkOnrampStatus does the actual dispatch by re-checking
 * the order itself, so this never goes stale even if a lot of time passes
 * before someone taps it), just with a label that tells you up front whether
 * the burn already happened:
 *
 *   - No cctpTransferId: the order never got a CCTP transfer recorded, which
 *     only happens after a burn confirms on-chain — so it didn't burn.
 *     Tapping submits a fresh one.
 *   - cctpTransferId present: a burn DID confirm and get recorded; whatever
 *     failed happened after that. Tapping resumes it — never re-burns.
 */
export function bridgeFailedButton(
  orderId: string,
  cctpTransferId?: string,
): InlineKeyboardMarkup {
  return statusButton(
    orderId,
    cctpTransferId
      ? "♻️ Revive transfer (burn confirmed)"
      : "🔁 Retry bridge (new burn)",
  );
}

/**
 * Send a Telegram message. Returns true if delivered, false otherwise.
 * Silently no-ops (returns false) when env is unconfigured so local/dev runs
 * don't error.
 */
export async function notify(
  message: string,
  level: AlertLevel = "info",
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    // Not configured — treat as a no-op rather than an error.
    return false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${ICON[level]} ${message}`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      },
    );
    return res.ok;
  } catch {
    // Best-effort: never let a notification failure propagate.
    return false;
  }
}

/**
 * Dismiss a Telegram inline-button loading spinner. `text`, if given, shows
 * as a brief toast to the tapper instead of a chat message.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }),
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Critical alert requiring manual intervention — e.g. onramp fiat settled but
 * the Base→Stellar bridge failed, leaving funds held in the hot wallet.
 */
export async function alertManualAction(details: {
  title: string;
  orderId: string;
  amount?: string;
  currency?: string;
  stellarAddress?: string;
  reason?: string;
  /**
   * Pass the order's cctpTransferId when known at alert time so the button
   * label tells you up front whether the burn already confirmed (see
   * bridgeFailedButton) — e.g. when a CCTP transfer itself just exhausted
   * its retries, vs. the bridge never getting far enough to burn at all.
   */
  cctpTransferId?: string;
}): Promise<boolean> {
  const lines = [
    `<b>MANUAL ACTION NEEDED — ${escapeHtml(details.title)}</b>`,
    `Order: <code>${escapeHtml(details.orderId)}</code>`,
    details.amount &&
      `Amount held: ${escapeHtml(details.amount)} ${escapeHtml(details.currency ?? "")}`.trim(),
    details.stellarAddress &&
      `User Stellar: <code>${escapeHtml(details.stellarAddress)}</code>`,
    details.reason && `Reason: ${escapeHtml(details.reason)}`,
  ].filter(Boolean);

  // Always onramp-only (offramp has no held-funds/manual-review state).
  return notify(
    lines.join("\n"),
    "critical",
    bridgeFailedButton(details.orderId, details.cctpTransferId),
  );
}

/**
 * Rich per-transaction alert for BOTH ramps. Sent at order creation
 * (status "created") and on every status change, so you get one message per
 * event with the full picture: bank details, amount, rate, payout value, and
 * status.
 *
 * Offramp: amount is USDC in, payout is fiat out to the recipient bank.
 * Onramp:  amount is fiat in, payout is USDC out to the user's Stellar wallet;
 *          the bank shown is the user's refund account.
 */
export async function alertRampEvent(details: {
  direction: "offramp" | "onramp";
  orderId: string;
  status: string;
  accountName?: string;
  accountNumber?: string;
  bank?: string;
  currency?: string;
  amountIn?: number | string; // offramp: USDC; onramp: fiat
  amountInUnit?: string; // e.g. "USDC" or the fiat code
  rate?: number | string;
  payoutValue?: number | string; // offramp: fiat; onramp: USDC
  payoutUnit?: string;
  stellarAddress?: string; // onramp: where USDC is delivered
  reference?: string;
}): Promise<boolean> {
  const s = (details.status || "unknown").toLowerCase();

  // What counts as done differs by direction. For an offramp the recipient's
  // bank is credited at `fulfilled`, and `validated` is the first webhook that
  // follows it — `settled` is Paycrest squaring up onchain with the provider
  // ~16s later, which the user isn't waiting on. For an onramp `validated`
  // only means the stablecoin release was authorised, so delivery is still
  // `settled`/`delivered`.
  const isSuccess =
    details.direction === "onramp"
      ? s === "settled" || s === "delivered"
      : s === "validated" || s === "fulfilled" || s === "settled";

  const level: AlertLevel = isSuccess
    ? "success"
    : s === "refunded" ||
        s === "expired" ||
        s === "bridge_failed" ||
        s === "failed"
      ? "warning"
      : "info";

  const fmt = (v?: number | string) =>
    v === undefined || v === null ? "—" : escapeHtml(String(v));

  // Money is grouped so a Telegram figure can be compared with the app at a
  // glance; a bare 1550000 next to the UI's ₦1,550,000.00 reads as a
  // discrepancy even when the values agree.
  const fmtMoney = (v?: number | string) => {
    if (v === undefined || v === null) return "—";
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    if (!Number.isFinite(n)) return fmt(v);
    return escapeHtml(
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
    );
  };
  const label = details.direction === "onramp" ? "ONRAMP" : "OFFRAMP";
  const amountUnit = details.amountInUnit
    ? ` ${escapeHtml(details.amountInUnit)}`
    : "";
  const payoutUnit = details.payoutUnit
    ? ` ${escapeHtml(details.payoutUnit)}`
    : details.currency
      ? ` ${escapeHtml(details.currency)}`
      : "";

  const lines = [
    `<b>${label} · ${escapeHtml(s.toUpperCase())}</b>`,
    `Order: <code>${escapeHtml(details.orderId)}</code>`,
    details.accountName && `Name: ${escapeHtml(details.accountName)}`,
    details.accountNumber &&
      `Account: <code>${escapeHtml(details.accountNumber)}</code>` +
        (details.bank ? ` (${escapeHtml(details.bank)})` : ""),
    details.amountIn !== undefined &&
      `Amount: ${fmtMoney(details.amountIn)}${amountUnit}`,
    details.rate !== undefined && `Rate: ${fmtMoney(details.rate)}`,
    details.payoutValue !== undefined &&
      `Payout: ${fmtMoney(details.payoutValue)}${payoutUnit}`,
    details.stellarAddress &&
      `Stellar: <code>${escapeHtml(details.stellarAddress)}</code>`,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean);

  // Onramp has a bridging step whose completion isn't always caught right
  // away (open-tab SSE or a once-daily cron), so give a way to check now.
  const markup =
    details.direction === "onramp" ? statusButton(details.orderId) : undefined;

  return notify(lines.join("\n"), level, markup);
}

/**
 * Rich per-transaction offramp alert. Thin wrapper over {@link alertRampEvent}
 * kept for existing callers.
 */
export async function alertOfframpEvent(details: {
  orderId: string;
  status: string; // e.g. "created", "pending", "settled", "refunded"
  accountName?: string;
  accountNumber?: string;
  bank?: string;
  currency?: string;
  amountUsdc?: number | string;
  rate?: number | string;
  payoutValue?: number | string;
  reference?: string;
}): Promise<boolean> {
  return alertRampEvent({
    direction: "offramp",
    orderId: details.orderId,
    status: details.status,
    accountName: details.accountName,
    accountNumber: details.accountNumber,
    bank: details.bank,
    currency: details.currency,
    amountIn: details.amountUsdc,
    amountInUnit: "USDC",
    rate: details.rate,
    payoutValue: details.payoutValue,
    payoutUnit: details.currency,
    reference: details.reference,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
