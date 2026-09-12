"use client";

import { useEffect, useRef, useState } from "react";
import { stepToAgentEvent, type AgentStepEvent } from "@/lib/offramp/agent-step-bridge";
// Type-only import — erased at compile time, so this client component never
// pulls in the resolver's server-side fetch logic at runtime. Reusing the
// server's own type here (instead of hand-duplicating an equivalent shape)
// is what keeps the two from silently drifting apart.
import type { AgentOrderWithQuote } from "@/lib/offramp/agent-resolver";
import type { OfframpStep } from "@/components/TransactionProgressModal";
import { fiatSymbol } from "@/lib/format/currency";

type ParseResponse =
  | { kind: "clarify"; message: string }
  | { kind: "recap"; missing: string[] }
  | { kind: "resolved"; order: AgentOrderWithQuote }
  | { kind: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: AgentOrderWithQuote; // present only on the confirmation-card message
  // Lifecycle of a confirmation card: undefined until Confirm/Cancel is
  // clicked, "confirmed" while the run is in flight, then "success"/"failed"
  // once offrampStep resolves (or "cancelled" if declined or aborted mid-run).
  orderStatus?: "confirmed" | "success" | "failed" | "cancelled";
  stepKind?: AgentStepEvent["kind"]; // present only on step-narration messages
}

let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;

export interface AgentPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  readonly sourceChainLabel: string;
  readonly offrampStep: OfframpStep;
  readonly offrampError: string | null;
  readonly active: boolean;
  readonly onCancelFlow: () => void;
  readonly onInitiateOfframp: (tradeData: {
    amount: string;
    rate: number;
    destinationAmount: string;
    token: string;
    sourceChain: AgentOrderWithQuote["sourceChain"];
    beneficiary: AgentOrderWithQuote["beneficiary"];
  }) => Promise<void> | void;
}

/**
 * Natural-language front end for the offramp pipeline. Sits alongside
 * FormCard in the same grid slot (StellarampDashboard picks one or the
 * other based on `mode`). Confirming a resolved order calls the exact same
 * `handleExecuteTrade` dispatcher FormCard's button calls — this component
 * never signs or submits anything itself.
 */
export function AgentPanel({
  isConnected,
  isConnecting,
  onConnect,
  sourceChainLabel,
  offrampStep,
  offrampError,
  active,
  onCancelFlow,
  onInitiateOfframp,
}: Readonly<AgentPanelProps>) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: "agent",
      text: 'Tell me what you\'d like to offramp, e.g. "Offramp 500 USDC on Base to my GTBank account 0123456789, Jane Doe".',
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lastRenderedStepId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mirrors TransactionProgressModal's own `canCancel` — only while waiting
  // on the wallet or the on-chain submit, and only for a run this panel
  // itself started.
  const canCancel =
    active && (offrampStep === "awaiting-signature" || offrampStep === "submitting");

  // Drives the typing dots during the gaps between step-narration messages
  // (e.g. while polling payout status) so the run doesn't look stalled.
  const isExecuting =
    active && offrampStep !== "idle" && offrampStep !== "success" && offrampStep !== "error";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, isSending, isExecuting]);

  // Narrate execution: every offrampStep change, while this panel owns the
  // current run, becomes one more chat message. Resets when a fresh run
  // starts (offrampStep returns to "idle"). Success/error also resolve the
  // in-flight confirmation card's status, driven off the same prop change
  // rather than re-reading it after an await — reading offrampStep from a
  // closure captured before an async gap is exactly the staleness bug that
  // caused the "Quote unavailable" double-click issue.
  useEffect(() => {
    if (!active) return;
    if (offrampStep === "idle") {
      lastRenderedStepId.current = null;
      return;
    }
    if (offrampStep === "success" || offrampStep === "error") {
      setMessages((prev) => {
        const idx = [...prev].reverse().findIndex((m) => m.orderStatus === "confirmed");
        if (idx === -1) return prev;
        const realIdx = prev.length - 1 - idx;
        const next = [...prev];
        next[realIdx] = { ...next[realIdx], orderStatus: offrampStep === "success" ? "success" : "failed" };
        return next;
      });
    }
    const event = stepToAgentEvent(offrampStep, { sourceChainLabel, error: offrampError });
    if (!event || event.id === lastRenderedStepId.current) return;
    lastRenderedStepId.current = event.id;
    setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: event.text, stepKind: event.kind }]);
  }, [active, offrampStep, offrampError, sourceChainLabel]);

  const conversationForOrder = (): { role: string; content: string }[] => {
    // Everything back to (and including) the last user/agent exchange that
    // hasn't yet produced a resolved order — a resolved-order card or a
    // completed run starts a fresh segment.
    const lastOrderIndex = [...messages].reverse().findIndex((m) => m.order);
    const startIndex = lastOrderIndex === -1 ? 0 : messages.length - lastOrderIndex;
    return messages
      .slice(startIndex)
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, content: m.text! }));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    const userMessage: ChatMessage = { id: nextId(), role: "user", text };
    const history = [...conversationForOrder(), { role: "user", content: text }];
    setMessages((prev) => [...prev, userMessage]);
    setIsSending(true);
    try {
      const res = await fetch("/api/offramp/agent/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data: ParseResponse = await res.json();
      if (data.kind === "clarify") {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: data.message }]);
      } else if (data.kind === "recap") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: `I still need: ${data.missing.join(", ")}.` },
        ]);
      } else if (data.kind === "resolved") {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", order: data.order }]);
      } else {
        setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: data.message }]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "agent", text: "I couldn't reach the server — please try again." },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const confirmOrder = async (order: AgentOrderWithQuote) => {
    if (!isConnected) {
      onConnect();
      return;
    }
    setConfirming(true);
    // Hide Confirm/Cancel the moment the run starts — step narration + the
    // typing indicator take over from here, and success/error resolve this
    // below via the offrampStep effect above.
    setMessages((prev) =>
      prev.map((m) => (m.order === order ? { ...m, orderStatus: "confirmed" } : m)),
    );
    try {
      // The quote shown on the card (order.rate/destinationAmount) is reused
      // as-is here — it's the same fetch, done once by the parse route
      // before the card was ever shown, so this is exactly the number the
      // user agreed to, not a second unseen quote.
      await onInitiateOfframp({
        amount: order.amount,
        rate: order.rate,
        destinationAmount: order.destinationAmount,
        token: order.token,
        sourceChain: order.sourceChain,
        beneficiary: order.beneficiary,
      });
    } finally {
      setConfirming(false);
    }
  };

  const cancelOrder = (order: AgentOrderWithQuote) => {
    setMessages((prev) => [
      ...prev.map((m) => (m.order === order ? { ...m, orderStatus: "cancelled" as const } : m)),
      { id: nextId(), role: "agent", text: "Cancelled — send a new message whenever you're ready." },
    ]);
  };

  const cancelFlowAndOrder = () => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.orderStatus === "confirmed");
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      const next = [...prev];
      next[realIdx] = { ...next[realIdx], orderStatus: "cancelled" };
      return next;
    });
    onCancelFlow();
  };

  return (
    <div className="racing-border-wrapper">
      <section className="racing-border-content flex flex-col gap-[1.1rem] p-[1.2rem]">
        <div className="flex items-center justify-between border-b border-[var(--line)] pb-[0.6rem]">
          <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">AGENT MODE</h2>
          <span className="text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">Offramp</span>
        </div>

        <div ref={listRef} className="flex max-h-[420px] min-h-[300px] flex-col gap-[0.65rem] overflow-y-auto">
          {messages.map((m) => {
            if (m.order) {
              const o = m.order;
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[92%] border border-[var(--line)] bg-[#101010] p-[0.8rem]">
                    <div className="mb-[0.55rem] text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Offramp Summary
                    </div>
                    {[
                      ["Amount", `${o.amount} ${o.token}`],
                      ["Source", o.sourceChain],
                      ["Bank", o.beneficiary.institution],
                      ["Account", o.beneficiary.accountIdentifier],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]">
                        <span className="text-[var(--muted)]">{label}</span>
                        <span>{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]">
                      <span className="text-[var(--muted)]">Account name</span>
                      <span className="text-[var(--accent)]">{o.beneficiary.accountName} ✓ verified</span>
                    </div>
                    <div className="flex justify-between border-b border-dashed border-[#222] py-[0.22rem] text-[0.78rem]">
                      <span className="text-[var(--muted)]">Rate</span>
                      <span>
                        {fiatSymbol(o.beneficiary.currency)}
                        {o.rate.toLocaleString()} / {o.token}
                      </span>
                    </div>
                    <div className="flex justify-between py-[0.22rem] text-[0.78rem]">
                      <span className="text-[var(--muted)]">You receive</span>
                      <span className="font-bold text-[var(--accent)]">
                        {fiatSymbol(o.beneficiary.currency)}
                        {o.destinationAmount}
                      </span>
                    </div>
                    {!m.orderStatus && (
                      <div className="mt-[0.7rem] flex gap-[0.5rem]">
                        <button
                          type="button"
                          disabled={confirming}
                          onClick={() => confirmOrder(o)}
                          className="flex-1 bg-[var(--accent)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#0a0a0a] disabled:opacity-50"
                        >
                          {confirming ? "Working…" : isConnected ? "Confirm" : "Connect Wallet"}
                        </button>
                        <button
                          type="button"
                          disabled={confirming}
                          onClick={() => cancelOrder(o)}
                          className="flex-1 border border-[var(--line)] py-[0.55rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {m.orderStatus === "success" && (
                      <div className="mt-[0.7rem] py-[0.4rem] text-center text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                        ✓ Successful
                      </div>
                    )}
                    {m.orderStatus === "failed" && (
                      <div className="mt-[0.7rem] py-[0.4rem] text-center text-[0.72rem] font-bold uppercase tracking-[0.08em] text-red-400">
                        ✗ Failed
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[82%] bg-[var(--accent)] px-[0.75rem] py-[0.55rem] text-[0.82rem] font-medium text-[#0a0a0a]"
                      : `max-w-[82%] border border-[var(--line)] bg-[#141414] px-[0.75rem] py-[0.55rem] text-[0.82rem] ${
                          m.stepKind === "error" ? "text-red-400" : m.stepKind === "success" ? "text-[var(--accent)]" : ""
                        }`
                  }
                >
                  {m.text}
                </div>
              </div>
            );
          })}
          {(isSending || isExecuting) && (
            <div className="flex justify-start">
              <div className="flex items-center gap-[3px] border border-[var(--line)] bg-[#141414] px-[0.75rem] py-[0.65rem]">
                <span
                  className="dot-bounce inline-block h-[5px] w-[5px] rounded-full bg-[var(--muted)]"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="dot-bounce inline-block h-[5px] w-[5px] rounded-full bg-[var(--muted)]"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="dot-bounce inline-block h-[5px] w-[5px] rounded-full bg-[var(--muted)]"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
            </div>
          )}
        </div>

        {canCancel && (
          <button
            type="button"
            onClick={cancelFlowAndOrder}
            className="w-full py-[0.5rem] text-[0.7rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] hover:text-white"
          >
            Cancel
          </button>
        )}

        <div className="flex gap-[0.5rem] border-t border-[var(--line)] pt-[0.8rem]">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={isSending}
            placeholder="e.g. Offramp 500 USDC on Solana to my GTBank account…"
            className="h-[42px] flex-1 border border-[var(--line)] bg-[#0a0a0a] px-[0.7rem] text-[0.8rem] text-[var(--foreground)] outline-none placeholder:text-[#555]"
          />
          <button
            type="button"
            onClick={send}
            disabled={isSending || !input.trim()}
            className="bg-[var(--accent)] px-[1rem] text-[0.75rem] font-bold uppercase tracking-[0.05em] text-[#0a0a0a] disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </section>
    </div>
  );
}
