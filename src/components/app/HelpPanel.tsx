"use client";

import { useState, type FormEvent } from "react";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import {
  buildMailtoUrl,
  buildWhatsAppUrl,
  PHONE_LINES,
  REPORT_CATEGORIES,
  SOCIAL_LINKS,
  SUPPORT_EMAIL,
  TELEGRAM_SUPPORT,
  WHATSAPP_DISPLAY,
  WHATSAPP_NUMBER,
  type ReportCategory,
  type SupportReport,
} from "@/lib/support/contact";
import { AppSelect } from "./AppSelect";

const LABEL =
  "font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#a19d9d]";
const FIELD =
  "h-[64px] w-full rounded-[20px] bg-transparent px-[20px] font-[family-name:var(--font-sora)] text-[16px] text-white outline-none placeholder:text-[#8d8c8c]";
const CARD =
  "flex flex-col gap-[20px] rounded-[30px] border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl bg-white/[0.04] p-[30px] max-[700px]:p-[20px]";

export function HelpPanel() {
  const { wallet } = useStellarWallet();
  const [category, setCategory] = useState<ReportCategory>("transaction");
  const [orderId, setOrderId] = useState("");
  const [debitedWallet, setDebitedWallet] = useState("");
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const [sentVia, setSentVia] = useState<"whatsapp" | "email" | null>(null);

  const tooShort = message.trim().length < 10;
  // The order id is only asked for where one exists — requiring it of a
  // general question would block someone who has no transaction to point at.
  const needsOrderId = category === "transaction" || category === "bug";
  const missingOrderId = needsOrderId && orderId.trim().length === 0;

  // Both destinations carry the identical report; the user picks whichever
  // they'd rather send from. Not both at once — firing two handoffs off one
  // click trips popup blockers and leaves people unsure what actually sent.
  const send = (via: "whatsapp" | "email") => {
    setTouched(true);
    if (tooShort || missingOrderId) return;

    const report: SupportReport = {
      category,
      message,
      orderId,
      debitedWallet,
      walletAddress: wallet?.publicKey,
    };
    const url = via === "whatsapp" ? buildWhatsAppUrl(report) : buildMailtoUrl(report);
    // New tab, not a redirect: this hands off to WhatsApp or a mail client,
    // and losing the page you were reporting about would be a poor trade.
    window.open(url, "_blank", "noopener,noreferrer");
    setSentVia(via);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send("whatsapp");
  };

  return (
    <div className="flex min-w-0 flex-col gap-[26px]">
      <p className="max-w-[720px] font-[family-name:var(--font-sora)] text-[16px] leading-[26px] text-[#bab6b6]">
        Hit a problem, or something looks wrong? Tell us below and it opens in
        WhatsApp ready to send. Common questions are answered in the{" "}
        <a href="/#faq" className="text-[#c9a962] underline-offset-4 hover:underline">
          FAQ
        </a>
        .
      </p>

      <div className="grid grid-cols-[1.35fr_1fr] gap-[26px] max-[1000px]:grid-cols-1">
        <form onSubmit={submit} className={CARD}>
          <h2 className="font-fraunces text-[22px] leading-[28px] text-white">
            Report a problem
          </h2>

          <label className="flex flex-col gap-[10px]">
            <span className={LABEL}>What&apos;s it about?</span>
            <AppSelect
              value={category}
              onChange={(next) => setCategory(next as ReportCategory)}
              options={REPORT_CATEGORIES.map((c) => ({ code: c.value, name: c.label }))}
            />
          </label>

          {/* Required for the two categories that are always about a specific
              transaction — it's the single most useful thing support can be
              handed. Not shown at all for the others, where there is no order
              to point at and demanding one would just block the report. */}
          {needsOrderId && (
            <label className="flex flex-col gap-[10px]">
              <span className={LABEL}>Order ID</span>
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="Paste from the transaction's details"
                aria-invalid={touched && missingOrderId}
                style={{
                  border: `1px solid ${
                    touched && missingOrderId ? "#ca4c4c" : "rgba(255,255,255,0.14)"
                  }`,
                }}
                className={FIELD}
              />
              {touched && missingOrderId && (
                <span className="font-[family-name:var(--font-sora)] text-[13px] leading-[17px] text-[#ca4c4c]">
                  Find this in the transaction&apos;s details on History or
                  Notifications.
                </span>
              )}
            </label>
          )}

          {needsOrderId && (
            <label className="flex flex-col gap-[10px]">
              <span className={LABEL}>Wallet the USDC left (optional)</span>
              <input
                value={debitedWallet}
                onChange={(e) => setDebitedWallet(e.target.value)}
                placeholder="Stellar, EVM or Solana address you sent from"
                style={{ border: "1px solid rgba(255,255,255,0.14)" }}
                className={FIELD}
              />
              {/* Not the same as the connected wallet: an offramp can be
                  funded from an EVM or Solana account, and this is the one
                  support needs to find the transaction on-chain. */}
              <span className="font-[family-name:var(--font-sora)] text-[12px] leading-[17px] text-[#8d8c8c]">
                If your balance was debited but nothing arrived, this is what
                lets us find and recover it.
              </span>
            </label>
          )}

          <label className="flex flex-col gap-[10px]">
            <span className={LABEL}>What happened?</span>
            <textarea
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setSentVia(null);
              }}
              onBlur={() => setTouched(true)}
              rows={5}
              placeholder="Tell us what you were doing and what went wrong."
              style={{ border: "1px solid rgba(255,255,255,0.14)" }}
              className="w-full resize-y rounded-[20px] bg-transparent p-[20px] font-[family-name:var(--font-sora)] text-[16px] leading-[24px] text-white outline-none placeholder:text-[#8d8c8c]"
            />
            {touched && tooShort && (
              <span className="font-[family-name:var(--font-sora)] text-[13px] leading-[17px] text-[#ca4c4c]">
                A sentence or two, so we know what to look at.
              </span>
            )}
          </label>

          <p className="font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#8d8c8c]">
            {wallet?.publicKey
              ? "Your connected wallet address is included so we can find the transaction."
              : "Connect your wallet first if this is about a transaction — it gets included so we can find it."}
          </p>

          {/* Inline background: globals.css has an unlayered
              `button { background: none }` reset that beats bg-* here. */}
          <div className="flex flex-wrap gap-[12px]">
            <button
              type="submit"
              style={{ backgroundColor: "#c9a962" }}
              className="flex h-[60px] flex-1 items-center justify-center rounded-[40px] px-[24px] font-[family-name:var(--font-sora)] text-[16px] font-medium text-[#1a1a1a] transition-[filter] hover:brightness-110 max-[520px]:w-full max-[520px]:flex-none"
            >
              Send on WhatsApp
            </button>
            <button
              type="button"
              onClick={() => send("email")}
              style={{ border: "1px solid #D7D6D6" }}
              className="flex h-[60px] flex-1 items-center justify-center rounded-[40px] px-[24px] font-[family-name:var(--font-sora)] text-[16px] text-[#e6e3e3] transition-[filter] hover:brightness-125 max-[520px]:w-full max-[520px]:flex-none"
            >
              Send by email
            </button>
          </div>

          {sentVia && (
            <p
              role="status"
              className="font-[family-name:var(--font-sora)] text-[14px] leading-[20px] text-[#c9a962]"
            >
              {sentVia === "whatsapp"
                ? "WhatsApp should have opened with your message ready to send."
                : `Your mail app should have opened with a message to ${SUPPORT_EMAIL}.`}{" "}
              If it didn&apos;t, check for a blocked popup, or reach us directly
              using the details alongside.
            </p>
          )}
        </form>

        <div className="flex flex-col gap-[26px]">
          <div className={CARD}>
            <h2 className="font-fraunces text-[22px] leading-[28px] text-white">
              Reach us
            </h2>
            <ul className="flex flex-col gap-[12px]">
              {PHONE_LINES.map((line) => (
                <li key={line.e164}>
                  <a
                    href={`tel:${line.e164}`}
                    className="font-[family-name:var(--font-sora)] text-[17px] leading-[24px] text-white transition-colors hover:text-[#c9a962]"
                  >
                    {line.display}
                  </a>
                </li>
              ))}
            </ul>
            <a
              href={`https://wa.me/${WHATSAPP_NUMBER}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-[family-name:var(--font-sora)] text-[17px] leading-[24px] text-white transition-colors hover:text-[#c9a962]"
            >
              WhatsApp · {WHATSAPP_DISPLAY}
            </a>
            <a
              href={TELEGRAM_SUPPORT.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-[family-name:var(--font-sora)] text-[17px] leading-[24px] text-white transition-colors hover:text-[#c9a962]"
            >
              Telegram · @{TELEGRAM_SUPPORT.username}
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-[#c9a962] underline-offset-4 hover:underline"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          <div className={CARD}>
            <h2 className="font-fraunces text-[22px] leading-[28px] text-white">
              Follow us
            </h2>
            <ul className="flex flex-wrap gap-[12px] max-[720px]:flex-nowrap max-[720px]:gap-[8px]">
              {SOCIAL_LINKS.map((social) => (
                <li key={social.label}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ border: "1px solid rgba(255,255,255,0.15)" }}
                    className="flex h-[46px] items-center whitespace-nowrap rounded-[40px] px-[20px] font-[family-name:var(--font-sora)] text-[15px] text-[#e6e3e3] transition-colors hover:text-[#c9a962] max-[720px]:h-[40px] max-[720px]:px-[14px] max-[720px]:text-[13px]"
                  >
                    {social.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
