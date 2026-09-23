/**
 * Where users can reach the team. One place, because these appear on the
 * Help screen today and will appear in the landing footer and error states
 * later — three copies of a phone number is three chances to fix one and
 * miss the others.
 */

/** Digits only, no "+" — wa.me rejects anything else. */
export const WHATSAPP_NUMBER = "2348189805590";

/**
 * The same number in local form, for display.
 *
 * Supplied as 081889805590, which is 12 digits where a Nigerian number has
 * 11 — one 8 too many, and one digit off the number above that WhatsApp
 * actually resolves to a chat. Shown as the corrected 08189805590 so the
 * text and the link can't disagree; worth confirming.
 */
export const WHATSAPP_DISPLAY = "0818 980 5590";

export interface PhoneLine {
  /** E.164, for the tel: link. */
  readonly e164: string;
  /** How it's shown, grouped for readability. */
  readonly display: string;
}

export const PHONE_LINES: readonly PhoneLine[] = [
  { e164: "+2347068895714", display: "+234 706 889 5714" },
  { e164: "+2349061228883", display: "+234 906 122 8883" },
  { e164: "+2348108399323", display: "+234 810 839 9323" },
];

export const SUPPORT_EMAIL = "setturails@gmail.com";

export interface SocialLink {
  readonly label: string;
  readonly href: string;
}

/** Telegram is support, not a feed, so it sits with the phone lines. */
export const TELEGRAM_SUPPORT = {
  username: "Xoulomon",
  href: "https://t.me/Xoulomon",
} as const;

export const SOCIAL_LINKS: readonly SocialLink[] = [
  { label: "X", href: "https://x.com/settu_official1" },
  { label: "LinkedIn", href: "https://www.linkedin.com/" },
  { label: "Instagram", href: "https://www.instagram.com/" },
];

export type ReportCategory =
  | "transaction"
  | "bug"
  | "account"
  | "question"
  | "other";

export const REPORT_CATEGORIES: readonly {
  value: ReportCategory;
  label: string;
}[] = [
  { value: "transaction", label: "Problem with a transaction" },
  { value: "bug", label: "Something isn't working" },
  { value: "account", label: "Wallet or account issue" },
  { value: "question", label: "General question" },
  { value: "other", label: "Something else" },
];

export interface SupportReport {
  readonly category: ReportCategory;
  readonly message: string;
  readonly orderId?: string;
  /** The wallet the user says was debited — typed, so it can be any chain. */
  readonly debitedWallet?: string;
  /** The Stellar wallet currently connected, filled in automatically. */
  readonly walletAddress?: string;
}

function categoryLabel(category: ReportCategory): string {
  return (
    REPORT_CATEGORIES.find((c) => c.value === category)?.label ?? "Support request"
  );
}

/**
 * The report body, assembled once so WhatsApp and email carry exactly the
 * same thing — and so the shape that reaches support can be changed (and
 * tested) in one place, without rendering anything.
 */
function reportBody(input: SupportReport): string {
  const lines = [input.message.trim()];

  // Context the user shouldn't have to type, and that support always asks
  // for. Only included when actually known.
  const context = [
    input.orderId?.trim() ? `Order ID: ${input.orderId.trim()}` : null,
    // The debited wallet is the one support actually needs to find a
    // stranded burn on-chain, and it is often NOT the connected Stellar
    // account — the USDC may have been sent from an EVM or Solana wallet.
    input.debitedWallet?.trim() ? `Debited wallet: ${input.debitedWallet.trim()}` : null,
    input.walletAddress ? `Connected wallet: ${input.walletAddress}` : null,
  ].filter((v): v is string => v !== null);

  if (context.length > 0) lines.push("", "---", ...context);
  return lines.join("\n");
}

/** Opens a WhatsApp chat with the report pre-composed. */
export function buildWhatsAppUrl(input: SupportReport): string {
  const text = `Settu support — ${categoryLabel(input.category)}\n\n${reportBody(input)}`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

/**
 * Opens Gmail's web composer with the report addressed to support.
 *
 * Gmail's compose URL rather than `mailto:`, which hands off to whatever the
 * machine has registered as its mail handler — often something the user
 * doesn't actually read.
 *
 * Client-side rather than sending from the server because this app has no
 * mail provider configured: no credentials, no client library. Sending
 * server side would mean adding one, which is a deployment change rather
 * than a UI one.
 */
export function buildEmailComposeUrl(input: SupportReport): string {
  const subject = `Settu support — ${categoryLabel(input.category)}`;
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: SUPPORT_EMAIL,
    su: subject,
    body: reportBody(input),
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}
