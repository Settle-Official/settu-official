"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon, CloseIcon, SendIcon } from "@/components/app/icons";
import { useAgentUnread } from "@/components/app/AgentUnread";
import { PHONE_QUERY, useMediaQuery } from "@/components/app/useMediaQuery";
import {
  stepToAgentEvent,
  type AgentStepEvent,
} from "@/lib/offramp/agent-step-bridge";
// Type-only import — erased at compile time, so this client component never
// pulls in the resolver's server-side fetch logic at runtime. Reusing the
// server's own type here (instead of hand-duplicating an equivalent shape)
// is what keeps the two from silently drifting apart.
import type { AgentOrderWithQuote } from "@/lib/offramp/agent-resolver";
import type { ResolvedOnrampOrder } from "@/lib/offramp/agent-onramp-resolver";
import { onrampStatusToAgentEvent } from "@/lib/offramp/agent-onramp-step-bridge";
import type { CreateOnrampOrderResult } from "@/lib/onramp/client";
import { TransactionStorage } from "@/lib/transaction-storage";
import type { OfframpStep } from "@/components/TransactionProgressModal";
import { fiatSymbol } from "@/lib/format/currency";
import { sourceChainOptions } from "@/lib/offramp/source-chain-options";

type ParseResponse =
  | { kind: "clarify"; message: string }
  | { kind: "recap"; missing: string[] }
  | { kind: "resolved"; order: AgentOrderWithQuote }
  | { kind: "resolved-onramp"; order: ResolvedOnrampOrder }
  | { kind: "status"; message: string }
  | { kind: "error"; message: string };

// What's currently live (confirmed but not yet finished) or most recently
// finished, in the minimal shape the parse route needs — sent on every
// request so it can tell a status comment on THIS order apart from a new
// request, and so "do that again" has something concrete to repeat. Kept
// separate from AgentOrderWithQuote/ResolvedOnrampOrder (rather than reusing
// them directly) since those carry quote/rate fields the route doesn't need
// and shouldn't have to keep in sync with.
type PendingOrderSummary =
  | {
      direction: "offramp";
      amount: string;
      token: string;
      sourceChain: string;
      beneficiary: { institution: string; accountIdentifier: string; currency: string };
    }
  | { direction: "onramp"; fiatAmount: string; currency: string; refundAccount: { institution: string } };

type CompletedOrderSummary =
  | {
      direction: "offramp";
      amount: string;
      token: string;
      sourceChain: string;
      beneficiary: { institution: string; accountIdentifier: string; currency: string };
    }
  | {
      direction: "onramp";
      fiatAmount: string;
      currency: string;
      destinationAddress: string;
      refundAccount: { institution: string; accountIdentifier: string };
    };

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: AgentOrderWithQuote; // present only on the confirmation-card message
  // Lifecycle of a confirmation card: undefined until Confirm/Cancel is
  // clicked, "confirmed" while the run is in flight, then "success"/"failed"
  // once offrampStep resolves ("cancelled" if declined/aborted mid-run, or
  // "superseded" if an edit to this same draft produced a newer card before
  // this one was ever confirmed).
  // "resolved" = the run finished; the card keeps showing its figures and
  // loses its buttons. The outcome arrives as its own `result` message
  // further down the thread, rather than overwriting this card — that
  // rewrote history, putting a green tick above the step narration that
  // led to it.
  orderStatus?:
    | "confirmed"
    | "resolved"
    | "success"
    | "failed"
    | "cancelled"
    | "superseded";
  /** A standalone outcome card, appended after the closing narration. */
  result?: { kind: "success" | "failed"; title: string; body: string };
  stepKind?: AgentStepEvent["kind"]; // present only on step-narration messages
  onrampOrder?: ResolvedOnrampOrder; // present only on the onramp confirmation-card message
  // Same lifecycle shape as orderStatus, but a pre-creation failure clears
  // back to undefined instead of "failed" — nothing was created yet, so the
  // card should stay retryable rather than presenting a dead end.
  onrampOrderStatus?: "confirmed" | "success" | "failed" | "cancelled" | "superseded";
  virtualAccount?: {
    orderId: string;
    account: CreateOnrampOrderResult["providerAccount"];
  }; // present only on the post-confirm account-details message
}

let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;

export interface AgentPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  // Which chain the currently connected (or last-selected) wallet is on —
  // set by the Off-ramp tab's source-chain dropdown, not by Agent Mode
  // itself. A resolved order can name any supported chain regardless of
  // this, so confirmOrder checks the two match before ever touching
  // onInitiateOfframp.
  readonly activeSourceChain: AgentOrderWithQuote["sourceChain"];
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
  // No isConnected/onConnect gate needed for onramp — the destination
  // address can be given explicitly in the conversation. If the user
  // instead refers to "my connected wallet", the parse route substitutes
  // this address server-side; null if no Stellar wallet is connected.
  readonly onInitiateOnramp: (order: ResolvedOnrampOrder) => Promise<CreateOnrampOrderResult>;
  readonly connectedStellarAddress: string | null;
  /** Fired on every terminal onramp status (delivered, refunded, or
   * expired) — the wallet's balance may have just changed (or the user
   * needs to see that it didn't), regardless of which way the order ended. */
  readonly onOnrampSettled?: () => void;
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
  activeSourceChain,
  sourceChainLabel,
  offrampStep,
  offrampError,
  active,
  onCancelFlow,
  onInitiateOfframp,
  onInitiateOnramp,
  connectedStellarAddress,
  onOnrampSettled,
}: Readonly<AgentPanelProps>) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: "agent",
      text: 'Tell me what you\'d like to do — offramp crypto to your bank, e.g. "Offramp 500 USDC on Base to my GTBank account 0123456789, Jane Doe", or onramp fiat to USDC, e.g. "Buy 50000 NGN of USDC to GALC4...XZOQCR, refund to my OPay account 0987654321, Jane Doe".',
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isPhone = useMediaQuery(PHONE_QUERY);
  // The most recently *finished* order (offramp success or onramp
  // "delivered"), regardless of how long ago or how many segment resets have
  // happened since — this is what "do that again" repeats. Never cleared by
  // a fresh conversation segment; only ever overwritten by the next
  // completion.
  const [lastCompletedOrder, setLastCompletedOrder] = useState<CompletedOrderSummary | null>(null);
  // The onramp order currently awaiting the user's bank transfer (from the
  // moment it's created until a terminal status arrives). Offramp has no
  // equivalent state here — its "pending" window is `isExecuting` below,
  // derived straight from offrampStep.
  const [onrampPending, setOnrampPending] = useState<ResolvedOnrampOrder | null>(null);
  const lastRenderedStepId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // How many messages the user has actually scrolled down to see. Anything
  // beyond this index is "unread" — divided off in the render below, and
  // rolled up into the sidebar's Agent badge via AgentUnread.
  const [readCount, setReadCount] = useState(messages.length);
  // Whether the list was scrolled to (near) its bottom *before* the render
  // that's about to run — read inside the scroll-follow effect below to
  // decide whether new content should pull the view down with it. Only a
  // real scroll (the handler below) ever changes this; appending messages
  // does not, so it still holds the pre-update position when that effect
  // runs.
  const wasAtBottomRef = useRef(true);
  const { publish: publishAgentUnread } = useAgentUnread();
  // Lets `send()` force an immediate status re-check (instead of waiting up
  // to 12s for the backstop poll) the moment the user says something like
  // "I've sent the money" while an onramp order is pending. Set by
  // confirmOnrampOrder, cleared by teardownOnrampStream.
  const onrampCheckNowRef = useRef<(() => void) | null>(null);

  // Tracks the currently-active onramp delivery watcher (SSE + backstop poll
  // + visibility recheck — see confirmOnrampOrder). A ref, not state: this is
  // plumbing for a background subscription, not something that should
  // trigger a re-render on its own.
  const onrampStreamRef = useRef<{
    es: EventSource | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    pollTimer: ReturnType<typeof setInterval> | null;
    onVisible: () => void;
    done: boolean;
  } | null>(null);

  const teardownOnrampStream = () => {
    const s = onrampStreamRef.current;
    if (!s) return;
    s.done = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.pollTimer) clearInterval(s.pollTimer);
    document.removeEventListener("visibilitychange", s.onVisible);
    s.es?.close();
    onrampStreamRef.current = null;
    onrampCheckNowRef.current = null;
  };

  // Tears down the watcher on unmount only — confirmOnrampOrder itself tears
  // down any previous watcher before starting a new one, so a user
  // confirming a second onramp order in the same session doesn't leak the
  // first one's poller.
  useEffect(() => teardownOnrampStream, []);

  // Mirrors TransactionProgressModal's own `canCancel` — only while waiting
  // on the wallet or the on-chain submit, and only for a run this panel
  // itself started.
  const canCancel =
    active &&
    (offrampStep === "awaiting-signature" || offrampStep === "submitting");

  // Drives the typing dots during the gaps between step-narration messages
  // (e.g. while polling payout status) so the run doesn't look stalled.
  const isExecuting =
    active &&
    offrampStep !== "idle" &&
    offrampStep !== "success" &&
    offrampStep !== "error";

  // Sticky-scroll: only follow new content down if the user was already at
  // the bottom (i.e. actually watching it arrive, tab in the foreground).
  // Someone scrolled up reading earlier history — or away in another tab —
  // keeps their place, and whatever arrived while they weren't looking
  // stays behind the "Unread" divider until they scroll down to it.
  useEffect(() => {
    if (wasAtBottomRef.current && document.visibilityState === "visible") {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      setReadCount(messages.length);
    }
  }, [messages, isSending, isExecuting]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    wasAtBottomRef.current = atBottom;
    if (atBottom) setReadCount(messages.length);
  };

  // Returning to the tab counts as "looking" the same way scrolling to the
  // bottom does — but only if the list is already scrolled there; coming
  // back to a chat scrolled up shouldn't silently mark unseen messages read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && wasAtBottomRef.current) {
        setReadCount(messages.length);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [messages.length]);

  // The sidebar's Agent badge — see AgentUnread.tsx for why this is
  // published rather than owned locally: it needs to outlive this
  // component's unmount when the user navigates to another screen.
  useEffect(() => {
    publishAgentUnread(Math.max(0, messages.length - readCount));
  }, [messages.length, readCount, publishAgentUnread]);

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
    const confirmedOrder = [...messages]
      .reverse()
      .find((m) => m.order && m.orderStatus === "confirmed")?.order;

    if (offrampStep === "success" || offrampStep === "error") {
      if (offrampStep === "success") {
        if (confirmedOrder) {
          setLastCompletedOrder({
            direction: "offramp",
            amount: confirmedOrder.amount,
            token: confirmedOrder.token,
            sourceChain: confirmedOrder.sourceChain,
            beneficiary: {
              institution: confirmedOrder.beneficiary.institution,
              accountIdentifier: confirmedOrder.beneficiary.accountIdentifier,
              currency: confirmedOrder.beneficiary.currency,
            },
          });
        }
      }
      setMessages((prev) => {
        const idx = [...prev]
          .reverse()
          .findIndex((m) => m.orderStatus === "confirmed");
        if (idx === -1) return prev;
        const realIdx = prev.length - 1 - idx;
        const next = [...prev];
        next[realIdx] = { ...next[realIdx], orderStatus: "resolved" };
        return next;
      });
    }
    const event = stepToAgentEvent(offrampStep, {
      sourceChainLabel,
      error: offrampError,
    });
    if (!event || event.id === lastRenderedStepId.current) return;
    lastRenderedStepId.current = event.id;
    const outcome: ChatMessage[] =
      offrampStep === "success"
        ? [
            {
              id: nextId(),
              role: "agent",
              result: {
                kind: "success",
                title: confirmedOrder
                  ? `Done! ${fiatSymbol(confirmedOrder.beneficiary.currency)}${confirmedOrder.destinationAmount} is on its way`
                  : "Done! your money is on its way",
                body: confirmedOrder
                  ? `Sent to ${confirmedOrder.beneficiary.institution} •••• ${confirmedOrder.beneficiary.accountIdentifier.slice(-3)}. It usually lands within minutes.`
                  : "It usually lands within minutes.",
              },
            },
          ]
        : offrampStep === "error"
          ? [
              {
                id: nextId(),
                role: "agent",
                result: {
                  kind: "failed",
                  title: "Oops! Transaction failed",
                  body: offrampError || "That offramp didn't go through.",
                },
              },
            ]
          : [];
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "agent", text: event.text, stepKind: event.kind },
      ...outcome,
    ]);
  }, [active, offrampStep, offrampError, sourceChainLabel]);

  // A card that's merely been shown, or superseded by an edit, is NOT a
  // boundary — a follow-up correction ("actually make it 300") still needs
  // the draft's prior fields in view to merge against. Only an order that's
  // actually been acted on (confirmed/executing, cancelled, or resolved to
  // success/failure) closes the segment.
  const isSegmentBoundary = (m: ChatMessage): boolean =>
    (!!m.order && !!m.orderStatus && m.orderStatus !== "superseded") ||
    (!!m.onrampOrder && !!m.onrampOrderStatus && m.onrampOrderStatus !== "superseded");

  const conversationForOrder = (): { role: string; content: string }[] => {
    // Everything back to (and including) the last user/agent exchange since
    // the last segment boundary — see isSegmentBoundary above.
    const lastBoundaryIndex = [...messages].reverse().findIndex(isSegmentBoundary);
    const startIndex =
      lastBoundaryIndex === -1 ? 0 : messages.length - lastBoundaryIndex;
    return messages
      .slice(startIndex)
      .filter((m) => m.text)
      .map((m) => ({ role: m.role, content: m.text! }));
  };

  // Tells the parse route what's currently live, so it can recognize a
  // status comment ("I've sent the money") on THAT order instead of trying
  // to build a new one from the still-visible full field set.
  const pendingOrderPayload = (): PendingOrderSummary | null => {
    if (isExecuting) {
      const confirmed = [...messages]
        .reverse()
        .find((m) => m.order && m.orderStatus === "confirmed")?.order;
      if (confirmed) {
        return {
          direction: "offramp",
          amount: confirmed.amount,
          token: confirmed.token,
          sourceChain: confirmed.sourceChain,
          beneficiary: {
            institution: confirmed.beneficiary.institution,
            accountIdentifier: confirmed.beneficiary.accountIdentifier,
            currency: confirmed.beneficiary.currency,
          },
        };
      }
    }
    if (onrampPending) {
      return {
        direction: "onramp",
        fiatAmount: onrampPending.fiatAmount,
        currency: onrampPending.currency,
        refundAccount: { institution: onrampPending.refundAccount.institution },
      };
    }
    return null;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    const userMessage: ChatMessage = { id: nextId(), role: "user", text };
    const history = [
      ...conversationForOrder(),
      { role: "user", content: text },
    ];
    setMessages((prev) => [...prev, userMessage]);
    setIsSending(true);
    try {
      const res = await fetch("/api/offramp/agent/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          connectedStellarAddress,
          pendingOrder: pendingOrderPayload(),
          lastCompletedOrder,
        }),
      });
      const data: ParseResponse = await res.json();
      if (data.kind === "clarify") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: data.message },
        ]);
      } else if (data.kind === "recap") {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "agent",
            text: `I still need: ${data.missing.join(", ")}.`,
          },
        ]);
      } else if (data.kind === "status") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: data.message },
        ]);
        // Don't make them wait up to 12s for the backstop poll to notice —
        // "I've sent the money" is exactly the moment to check right away.
        onrampCheckNowRef.current?.();
      } else if (data.kind === "resolved") {
        setMessages((prev) => [
          ...prev.map((m) =>
            m.order && !m.orderStatus ? { ...m, orderStatus: "superseded" as const } : m,
          ),
          { id: nextId(), role: "agent", order: data.order },
        ]);
      } else if (data.kind === "resolved-onramp") {
        setMessages((prev) => [
          ...prev.map((m) =>
            m.onrampOrder && !m.onrampOrderStatus
              ? { ...m, onrampOrderStatus: "superseded" as const }
              : m,
          ),
          { id: nextId(), role: "agent", onrampOrder: data.order },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "agent", text: data.message },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "agent",
          text: "I couldn't reach the server — please try again.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const confirmOrder = async (order: AgentOrderWithQuote) => {
    // Agent Mode never switches the dashboard's active source chain itself —
    // that only happens via the Off-ramp tab's dropdown. A resolved order
    // can still name any supported chain, so a connected (or even
    // not-yet-connected) wallet on the wrong chain would otherwise sail
    // straight into onInitiateOfframp and fail deep inside the execute
    // path with a bare toast, leaving this card stuck with no explanation.
    // Catching the mismatch here, before ever calling onInitiateOfframp,
    // means the card's Confirm/Cancel buttons stay live so the user can
    // just switch wallets and try again.
    if (order.sourceChain !== activeSourceChain) {
      const targetLabel =
        sourceChainOptions().find((c) => c.code === order.sourceChain)?.name ??
        order.sourceChain;
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "agent",
          text: `Your connected wallet is on ${sourceChainLabel}, but this offramp needs ${targetLabel}. Switch to a ${targetLabel} wallet — pick ${targetLabel} from the Source Chain dropdown on the Off-ramp tab and connect it there — then come back and hit Confirm again.`,
          stepKind: "error",
        },
      ]);
      return;
    }
    if (!isConnected) {
      onConnect();
      return;
    }
    setConfirming(true);
    // Hide Confirm/Cancel the moment the run starts — step narration + the
    // typing indicator take over from here, and success/error resolve this
    // below via the offrampStep effect above.
    setMessages((prev) =>
      prev.map((m) =>
        m.order === order ? { ...m, orderStatus: "confirmed" } : m,
      ),
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
      ...prev.map((m) =>
        m.order === order ? { ...m, orderStatus: "cancelled" as const } : m,
      ),
      {
        id: nextId(),
        role: "agent",
        text: "Cancelled — send a new message whenever you're ready.",
      },
    ]);
  };

  const cancelFlowAndOrder = () => {
    setMessages((prev) => {
      const idx = [...prev]
        .reverse()
        .findIndex((m) => m.orderStatus === "confirmed");
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      const next = [...prev];
      next[realIdx] = { ...next[realIdx], orderStatus: "cancelled" };
      return next;
    });
    onCancelFlow();
  };

  const confirmOnrampOrder = async (order: ResolvedOnrampOrder) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.onrampOrder === order ? { ...m, onrampOrderStatus: "confirmed" } : m,
      ),
    );
    try {
      const result = await onInitiateOnramp(order);
      setMessages((prev) => [
        ...prev.map((m) =>
          m.onrampOrder === order ? { ...m, onrampOrderStatus: "success" as const } : m,
        ),
        {
          id: nextId(),
          role: "agent",
          virtualAccount: { orderId: result.id, account: result.providerAccount },
        },
      ]);

      // Tear down any previous onramp watcher before starting a new one —
      // mirrors OnrampPanel's own per-orderId effect cleanup, so confirming
      // a second onramp order in the same chat doesn't leak the first
      // poller/listener.
      teardownOnrampStream();
      // Marks this order "pending" from the caller's perspective — while
      // set, a plain status comment ("I've sent the money") gets a status
      // reply instead of a new confirmation card. See pendingOrderPayload().
      setOnrampPending(order);

      const lastStatus = { current: "" };
      const applyOnrampStatus = (status: string, stellarTxHash?: string): boolean => {
        if (status === lastStatus.current) return false;
        lastStatus.current = status;
        const event = onrampStatusToAgentEvent(status, { stellarTxHash });
        if (event) {
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: "agent", text: event.text, stepKind: event.kind },
          ]);
        }
        const terminal = status === "delivered" || status === "refunded" || status === "expired";
        if (terminal) {
          TransactionStorage.updateByOrderId(
            result.id,
            status === "delivered" ? { status: "completed" } : { status: "failed", error: status },
          );
          setOnrampPending(null);
          onOnrampSettled?.();
          // Only an actual delivery is worth repeating — a refund/expiry
          // means nothing landed, so "do that again" shouldn't offer to
          // redo the same order that just failed to complete.
          if (status === "delivered") {
            setLastCompletedOrder({
              direction: "onramp",
              fiatAmount: order.fiatAmount,
              currency: order.currency,
              destinationAddress: order.destinationAddress,
              refundAccount: {
                institution: order.refundAccount.institution,
                accountIdentifier: order.refundAccount.accountIdentifier,
              },
            });
          }
        }
        return terminal;
      };

      // Authoritative read, shared by the backstop poller and the
      // visibility recheck — same endpoint OnrampPanel itself falls back to.
      const fetchOnrampStatus = async (): Promise<boolean> => {
        try {
          const res = await fetch(`/api/onramp/order/${result.id}`);
          if (!res.ok) return false;
          const next = (await res.json())?.data?.status;
          return next ? applyOnrampStatus(next) : false;
        } catch {
          return false;
        }
      };

      const state: NonNullable<typeof onrampStreamRef.current> = {
        es: null,
        reconnectTimer: null,
        pollTimer: null,
        onVisible: () => {},
        done: false,
      };
      onrampStreamRef.current = state;

      // Paying the bank means leaving the browser, and a backgrounded tab
      // can lose the SSE connection with no event we can see — reconnect,
      // poll a backstop, and re-check whenever the tab comes back. Same
      // mechanism OnrampPanel uses, for the exact same reason: a plain
      // one-shot EventSource with no reconnect left delivery stuck behind a
      // manual "check status" step in practice.
      const connect = () => {
        if (state.done) return;
        const es = new EventSource(`/api/onramp/stream/${result.id}`);
        state.es = es;
        es.onmessage = (evt) => {
          let payload: { status?: string; stellarTxHash?: string };
          try {
            payload = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (payload.status && applyOnrampStatus(payload.status, payload.stellarTxHash)) {
            state.done = true;
            es.close();
          }
        };
        // A closed stream is routine (the route caps at 60s), not a failure.
        es.onerror = () => {
          if (es.readyState !== EventSource.CLOSED) return;
          es.close();
          state.es = null;
          if (!state.done) state.reconnectTimer = setTimeout(connect, 3000);
        };
      };

      const check = () => {
        if (state.done) return;
        fetchOnrampStatus().then((terminal) => {
          if (terminal) {
            state.done = true;
            state.es?.close();
          }
        });
      };
      onrampCheckNowRef.current = check;

      state.onVisible = () => {
        if (document.visibilityState === "visible") check();
      };

      connect();
      state.pollTimer = setInterval(check, 12000);
      document.addEventListener("visibilitychange", state.onVisible);
    } catch (e: any) {
      // Nothing was created — clear the status (not "failed") so
      // Confirm/Cancel reappear and the user can just retry.
      setOnrampPending(null);
      setMessages((prev) => [
        ...prev.map((m) =>
          m.onrampOrder === order ? { ...m, onrampOrderStatus: undefined } : m,
        ),
        {
          id: nextId(),
          role: "agent",
          text: e?.message || "Something went wrong creating that order — please try again.",
          stepKind: "error",
        },
      ]);
    }
  };

  const cancelOnrampOrder = (order: ResolvedOnrampOrder) => {
    setMessages((prev) => [
      ...prev.map((m) =>
        m.onrampOrder === order ? { ...m, onrampOrderStatus: "cancelled" as const } : m,
      ),
      {
        id: nextId(),
        role: "agent",
        text: "Cancelled — send a new message whenever you're ready.",
      },
    ]);
  };

  return (
    // flex-1 (not h-full): the parent <section> is itself sized by flex-grow
    // rather than an explicit height, and CSS height:100% doesn't reliably
    // resolve against that — flex-grow does, since it's the same layout
    // algorithm all the way down. min-h-0 lets this item shrink below its
    // content's natural size so it can actually be *smaller* than the
    // message list wants, which is what makes flex-1 fill exactly the
    // remaining space instead of overflowing it.
    <div className="flex min-h-0 flex-1 flex-col gap-[24px]">
      <div
        ref={listRef}
        data-lenis-prevent
        onScroll={onListScroll}
        // min-h-0: without it a flex child refuses to shrink below its
        // content's natural height, so this never actually overflowed
        // itself — the *page* did instead, and since data-lenis-prevent
        // tells Lenis to leave wheel events here alone (expecting this
        // element to handle its own scrolling), wheel did nothing at all;
        // only dragging the real scrollbar thumb (a direct scrollTop write,
        // not a wheel event) still worked. With min-h-0 this element is
        // genuinely the thing that overflows and scrolls.
        // px-[16px]: the bubble tails hang 14px off their bubble, so without
        // this gutter they'd reach past the list and either raise a
        // horizontal scrollbar or get clipped by overflow-x-hidden below.
        className="flex min-h-0 flex-1 flex-col gap-[28px] overflow-x-hidden overflow-y-auto overscroll-contain px-[16px] max-[720px]:gap-[20px] max-[720px]:px-[14px]"
      >
        {messages.map((m, i) => {
          // The divider sits right before the first message the user hasn't
          // scrolled down to yet — not tied to any particular message type,
          // so it marks a plain new reply the same as a resolved order.
          const isFirstUnread = readCount < messages.length && i === readCount;

          return (
            <div key={m.id} className="flex flex-col gap-[28px] max-[720px]:gap-[20px]">
              {isFirstUnread && <UnreadDivider />}
              <AgentMessage message={m} />
            </div>
          );
        })}
        {(isSending || isExecuting) && (
          <ChatBubble side="left" tone="narration">
            <span className="flex items-center gap-[4px] py-[2px]">
              <span
                className="dot-bounce inline-block size-[5px] rounded-full bg-[#8b8686]"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="dot-bounce inline-block size-[5px] rounded-full bg-[#8b8686]"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="dot-bounce inline-block size-[5px] rounded-full bg-[#8b8686]"
                style={{ animationDelay: "300ms" }}
              />
            </span>
          </ChatBubble>
        )}
      </div>

      {canCancel && (
        <button
          type="button"
          onClick={cancelFlowAndOrder}
          style={{ border: "1px solid rgba(255,255,255,0.6)" }}
          className="mx-auto flex h-[48px] items-center gap-[8px] rounded-[40px] px-[24px] font-[family-name:var(--font-sora)] text-[15px] text-[#e07a7e] transition-[filter] hover:brightness-125 max-[720px]:h-[44px] max-[720px]:text-[15px]"
        >
          Cancel
          <CloseIcon size={14} />
        </button>
      )}

      <div className="agent-composer flex items-center gap-[12px] rounded-[40px] bg-white/5 py-[8px] pl-[24px] pr-[8px] max-[720px]:gap-[10px] max-[720px]:rounded-none max-[720px]:bg-transparent max-[720px]:p-0">
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
          // 393px has no room for the long example; the phone design just
          // prompts with the greeting it wants back.
          placeholder={
            isPhone
              ? "Hey Agent"
              : "e.g. Offramp 500 USDC on Solana… or Buy 50000 NGN of USDC…"
          }
          className="h-[40px] min-w-0 flex-1 bg-transparent font-[family-name:var(--font-sora)] text-[16px] text-white outline-none placeholder:text-[#8d8c8c] max-[720px]:h-[52px] max-[720px]:rounded-[40px] max-[720px]:bg-[#6f6c6c] max-[720px]:px-[20px] max-[720px]:text-[15px] max-[720px]:placeholder:text-[#d8d5d5]"
        />
        <button
          type="button"
          onClick={send}
          disabled={isSending || !input.trim()}
          aria-label="Send"
          style={{ backgroundColor: "#c9a962" }}
          className="flex size-[48px] shrink-0 items-center justify-center rounded-full text-[#1a1a1a] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 max-[720px]:size-[52px]"
        >
          {/* Both glyphs are rendered and one is hidden per breakpoint —
              swapping on `isPhone` would flip the icon on hydration. */}
          <ArrowRightIcon size={20} className="max-[720px]:hidden" />
          <SendIcon size={20} className="hidden max-[720px]:block max-[720px]:size-[22px]" />
        </button>
      </div>
    </div>
  );

  function AgentMessage({ message: m }: { readonly message: ChatMessage }) {
    if (m.result) {
      return <ChatResultCard result={m.result} />;
    }
    if (m.order) {
      const o = m.order;
      return (
        <SummaryCard
          title="Offramp Summary"
          rows={[
            ["Amount", `${o.amount} ${o.token}`],
            ["Source", o.sourceChain],
            ["Bank", o.beneficiary.institution],
            ["Account", o.beneficiary.accountIdentifier],
            ["Account Name", `${o.beneficiary.accountName} ✓`, "accent"],
            ["Rate", `${fiatSymbol(o.beneficiary.currency)}${o.rate.toLocaleString()}/${o.token}`],
            ["You Receive", `${fiatSymbol(o.beneficiary.currency)}${o.destinationAmount}`, "accent-lg"],
          ]}
          status={m.orderStatus}
          onConfirm={() => confirmOrder(o)}
          onCancel={() => cancelOrder(o)}
          confirmLabel={confirming ? "Working…" : isConnected ? "Confirm" : "Connect Wallet"}
          confirmDisabled={confirming}
          // No success/failed text: an offramp card never takes those
          // statuses any more — the outcome is its own card further down.
        />
      );
    }
    if (m.onrampOrder) {
      const o = m.onrampOrder;
      return (
        <SummaryCard
          title="Onramp Summary"
          rows={[
            ["Amount", `${o.fiatAmount} ${o.currency}`],
            [
              "Destination",
              `${o.destinationAddress.slice(0, 6)}…${o.destinationAddress.slice(-6)}`,
            ],
            ["Refund bank", o.refundAccount.institution],
            ["Refund account", o.refundAccount.accountIdentifier],
            ["Refund Account Name", `${o.refundAccount.accountName} ✓`, "accent"],
          ]}
          status={m.onrampOrderStatus}
          onConfirm={() => confirmOnrampOrder(o)}
          onCancel={() => cancelOnrampOrder(o)}
          confirmLabel="Confirm"
          successText="Order created — pay into the account below."
        />
      );
    }
    if (m.virtualAccount) {
      const { account } = m.virtualAccount;
      return (
        <SummaryCard
          title="Pay Into This Account"
          rows={[
            ["Bank", account.institution],
            ["Account number", account.accountIdentifier],
            ["Account name", account.accountName, "accent"],
            ["Amount", `${account.amountToTransfer} ${account.currency}`, "accent"],
            ["Valid until", account.validUntil],
          ]}
        />
      );
    }

    const isUser = m.role === "user";
    const isNarration = !isUser && !!m.stepKind;
    return (
      <ChatBubble
        side={isUser ? "right" : "left"}
        tone={isNarration ? "narration" : "default"}
        stepKind={m.stepKind}
      >
        {m.text}
      </ChatBubble>
    );
  }
}

/** A boundary between what came before and what's new since — shown right
 * where a confirmed run resolves, since that's the one moment guaranteed to
 * be new even if the user switched away while it was processing. */
function UnreadDivider() {
  return (
    <div className="flex items-center gap-[16px]" role="separator">
      <span className="h-px flex-1 bg-white/10" />
      <span className="shrink-0 font-[family-name:var(--font-sora)] text-[13px] text-[#8d8c8c] max-[720px]:text-[13px]">
        Unread
      </span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  );
}

interface ChatBubbleProps {
  readonly side: "left" | "right";
  readonly tone: "default" | "narration";
  readonly stepKind?: AgentStepEvent["kind"];
  readonly children: ReactNode;
}

/**
 * A conversational turn gets the warm, bright bubble; a step-narration
 * update ("Starting your offramp…") gets a dimmer, muted one — the same
 * distinction the design draws between what you said and what the system
 * is quietly reporting in the background.
 */
function ChatBubble({ side, tone, stepKind, children }: ChatBubbleProps) {
  // Opaque, not translucent. These are the exact colours the old
  // rgba(66,58,45,0.15) and rgba(79,72,60,0.3) flattened to over the panel's
  // #191818 — so nothing changes visually — but the tail is a separate shape
  // that has to overlap the bubble to avoid a hairline gap, and with a
  // translucent fill that overlap double-darkens into a visible band.
  const bg = tone === "narration" ? "#1f1d1b" : "#292623";
  const textColor =
    tone === "narration"
      ? stepKind === "error"
        ? "#e07a7e"
        : stepKind === "success"
          ? "#c9a962"
          : "#8b8686"
      : "#ffffff";
  const left = side === "left";
  return (
    <div className={`flex ${left ? "justify-start" : "justify-end"}`}>
      <div
        style={{ backgroundColor: bg, color: textColor }}
        // The tail's corner is squared off completely so the tail meets a
        // straight edge — any radius there curves away from the tail and
        // opens a visible sliver between the two.
        // Phone: both tones share one size. The desktop pair (15/18px) reads
        // as a deliberate hierarchy across a wide column; at 393px it just
        // looks like inconsistent text, and the design sets every bubble the
        // same.
        className={`relative max-w-[70%] break-words rounded-[20px] px-[24px] py-[16px] font-[family-name:var(--font-sora)] leading-[26px] max-[720px]:max-w-[78%] max-[720px]:rounded-[14px] max-[720px]:px-[15px] max-[720px]:py-[13px] max-[720px]:text-[14.5px] max-[720px]:leading-[21px] ${
          left ? "rounded-bl-none" : "rounded-br-none"
        } ${tone === "narration" ? "text-[15px]" : "text-[18px]"}`}
      >
        {children}
        <BubbleTail side={side} color={bg} />
      </div>
    </div>
  );
}

/**
 * The iMessage-style tail: a crescent that hangs off the bubble's bottom
 * corner, concave on top where the bubble's own curve cuts into it, and
 * tapering to a point away from the bubble.
 *
 * An SVG rather than a rotated square — a square reads as a stray diamond
 * stuck to the corner, which is what this used to look like.
 */
function BubbleTail({ side, color }: { readonly side: "left" | "right"; readonly color: string }) {
  const left = side === "left";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 22"
      fill="none"
      // Size and the 2px overlap live in globals.css (.bubble-tail), because
      // the phone bubble is smaller and the tail has to shrink with it — and
      // an inline offset can't carry a media query.
      className={`bubble-tail absolute bottom-0 ${left ? "is-left" : "is-right"}`}
    >
      <path d="M14 22V6c0 8.2-5.6 15.2-14 16h14Z" fill={color} />
    </svg>
  );
}

/**
 * The outcome of a finished run, as its own card in the thread — it arrives
 * after the closing narration rather than replacing the summary card that
 * started it, so the conversation still reads in the order it happened.
 */
function ChatResultCard({
  result,
}: {
  readonly result: { kind: "success" | "failed"; title: string; body: string };
}) {
  const isSuccess = result.kind === "success";
  return (
    <div className="flex justify-start">
      <div className="flex w-[400px] max-w-full flex-col items-center gap-[16px] rounded-[20px] bg-[#232222] p-[24px] text-center max-[720px]:w-full max-[720px]:gap-[12px] max-[720px]:rounded-[14px] max-[720px]:p-[16px]">
        <span
          style={{ backgroundColor: isSuccess ? "#2fb457" : "#b23a3e" }}
          className="flex size-[56px] items-center justify-center rounded-full max-[720px]:size-[48px]"
        >
          {isSuccess ? (
            <CheckIcon size={28} strokeWidth={2.4} className="text-white" />
          ) : (
            <CloseIcon size={24} strokeWidth={2.4} className="text-white" />
          )}
        </span>
        <div className="flex flex-col gap-[6px]">
          <h3 className="font-fraunces text-[20px] leading-[26px] text-white max-[720px]:text-[17px] max-[720px]:leading-[22px]">
            {result.title}
          </h3>
          <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-[#d6d3d3] max-[720px]:text-[13px] max-[720px]:leading-[19px]">
            {result.body}
          </p>
        </div>
      </div>
    </div>
  );
}

type SummaryRow = [label: string, value: string, tone?: "accent" | "accent-lg"];

interface SummaryCardProps {
  readonly title: string;
  readonly rows: readonly SummaryRow[];
  readonly status?:
    | "confirmed"
    | "resolved"
    | "success"
    | "failed"
    | "cancelled"
    | "superseded";
  readonly onConfirm?: () => void;
  readonly onCancel?: () => void;
  readonly confirmLabel?: string;
  readonly confirmDisabled?: boolean;
  readonly successText?: string;
  readonly failedText?: string;
}

/** The confirmation/receipt cards the agent drops into the chat — offramp
 * and onramp summaries, the onramp deposit account, and (via `status`) the
 * live Confirm/Cancel state through to the done/failed outcome. */
function SummaryCard({
  title,
  rows,
  status,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  confirmDisabled,
  successText,
  failedText,
}: SummaryCardProps) {
  const isTerminal = status === "success" || status === "failed";
  return (
    <div className="flex justify-start">
      <div className="flex w-[400px] max-w-full flex-col gap-[16px] rounded-[20px] bg-[#232222] p-[24px] max-[720px]:w-full max-[720px]:gap-[12px] max-[720px]:rounded-[14px] max-[720px]:p-[16px]">
        {!isTerminal && (
          <>
            <h3 className="font-[family-name:var(--font-inter)] text-[13px] font-semibold uppercase tracking-[0.06em] text-[#8d8c8c] max-[720px]:text-[13px]">
              {title}
            </h3>
            <dl className="flex flex-col">
              {rows.map(([label, value, tone]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-[16px] border-b border-dashed border-white/10 py-[10px] last:border-b-0 max-[720px]:gap-[12px] max-[720px]:py-[8px]"
                >
                  <dt className="font-[family-name:var(--font-sora)] text-[15px] text-[#bdbcbc] max-[720px]:text-[14px]">
                    {label}
                  </dt>
                  <dd
                    className={`text-right font-[family-name:var(--font-inter)] ${
                      tone === "accent-lg"
                        ? "text-[20px] font-semibold text-[#c9a962] max-[720px]:text-[18px]"
                        : tone === "accent"
                          ? "text-[14px] text-[#c9a962] max-[720px]:text-[14px]"
                          : "text-[15px] text-white max-[720px]:text-[14px]"
                    }`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {!status && onConfirm && onCancel && (
          <div className="flex gap-[12px]">
            <button
              type="button"
              onClick={onCancel}
              disabled={confirmDisabled}
              style={{ border: "1px solid rgba(224,122,126,0.65)" }}
              className="flex h-[48px] flex-1 items-center justify-center gap-[8px] rounded-[16px] font-[family-name:var(--font-sora)] text-[15px] text-[#e07a7e] transition-[filter] hover:brightness-125 disabled:opacity-50 max-[720px]:h-[44px] max-[720px]:max-w-[96px] max-[720px]:gap-[6px] max-[720px]:rounded-[12px] max-[720px]:text-[14px]"
            >
              Cancel
              <CloseIcon size={15} />
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              style={{ backgroundColor: "#c9a962" }}
              className="h-[48px] flex-1 rounded-[16px] font-[family-name:var(--font-sora)] text-[15px] font-semibold text-[#1a1a1a] transition-[filter] hover:brightness-110 disabled:opacity-50 max-[720px]:h-[44px] max-[720px]:rounded-[12px] max-[720px]:text-[14px]"
            >
              {confirmLabel}
            </button>
          </div>
        )}

        {status === "confirmed" && (
          <p className="font-[family-name:var(--font-sora)] text-[14px] text-[#8d8c8c] max-[720px]:text-[14px]">
            Working on it…
          </p>
        )}

        {status === "success" && (
          <div className="flex flex-col items-center gap-[16px] py-[8px] text-center">
            <span
              style={{ backgroundColor: "#2fb457" }}
              className="flex size-[56px] items-center justify-center rounded-full max-[720px]:size-[48px]"
            >
              <CheckIcon size={28} strokeWidth={2.4} className="text-white" />
            </span>
            <p className="font-[family-name:var(--font-sora)] text-[16px] leading-[24px] text-white max-[720px]:text-[15px] max-[720px]:leading-[22px]">
              {successText}
            </p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex flex-col items-center gap-[16px] py-[8px] text-center">
            <span
              style={{ backgroundColor: "#b23a3e" }}
              className="flex size-[56px] items-center justify-center rounded-full max-[720px]:size-[48px]"
            >
              <CloseIcon size={24} strokeWidth={2.4} className="text-white" />
            </span>
            <p className="font-[family-name:var(--font-sora)] text-[16px] leading-[24px] text-white max-[720px]:text-[15px] max-[720px]:leading-[22px]">
              {failedText}
            </p>
          </div>
        )}

        {status === "cancelled" && (
          <p className="font-[family-name:var(--font-sora)] text-[14px] text-[#8d8c8c] max-[720px]:text-[14px]">Cancelled.</p>
        )}
        {status === "superseded" && (
          <p className="font-[family-name:var(--font-sora)] text-[14px] text-[#8d8c8c] max-[720px]:text-[14px]">
            Updated — see below.
          </p>
        )}
      </div>
    </div>
  );
}
