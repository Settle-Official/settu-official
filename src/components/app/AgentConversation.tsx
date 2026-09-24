"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AgentStepEvent } from "@/lib/offramp/agent-step-bridge";
import type { AgentOrderWithQuote } from "@/lib/offramp/agent-resolver";
import type { ResolvedOnrampOrder } from "@/lib/offramp/agent-onramp-resolver";
import type { CreateOnrampOrderResult } from "@/lib/onramp/client";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text?: string;
  order?: AgentOrderWithQuote; // present only on the confirmation-card message
  // Lifecycle of a confirmation card: undefined until Confirm/Cancel is
  // clicked, "confirmed" while the run is in flight, then "resolved" once
  // offrampStep settles ("cancelled" if declined/aborted mid-run, or
  // "superseded" if an edit to this same draft produced a newer card before
  // this one was ever confirmed).
  //
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

/**
 * The most recently *finished* order, in the minimal shape the parse route
 * needs — this is what "do that again" repeats.
 */
export type CompletedOrderSummary =
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

let messageSeq = 0;
export const nextId = () => `m${++messageSeq}`;

const GREETING = (): ChatMessage => ({
  id: nextId(),
  role: "agent",
  text: 'Tell me what you\'d like to do — offramp crypto to your bank, e.g. "Offramp 500 USDC on Base to my GTBank account 0123456789, Jane Doe", or onramp fiat to USDC, e.g. "Buy 50000 NGN of USDC to GALC4...XZOQCR, refund to my OPay account 0987654321, Jane Doe".',
});

interface AgentConversationValue {
  readonly messages: ChatMessage[];
  readonly setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  /** How many messages the user has actually scrolled down to see. */
  readonly readCount: number;
  readonly setReadCount: Dispatch<SetStateAction<number>>;
  readonly lastCompletedOrder: CompletedOrderSummary | null;
  readonly setLastCompletedOrder: Dispatch<SetStateAction<CompletedOrderSummary | null>>;
  /** Back to a single greeting, as if the tab had never been opened. */
  readonly clear: () => void;
}

const AgentConversationContext = createContext<AgentConversationValue | null>(null);

/**
 * The agent's conversation, held at the app-shell layout rather than inside
 * the panel.
 *
 * `/app/agent` is its own route, so its page — and everything AgentPanel
 * owns — fully unmounts the moment the user taps another tab. That threw
 * away the whole conversation, including one describing a transfer that was
 * still running. The layout does not unmount on a route change, so state
 * kept here survives navigation within /app.
 *
 * KNOWN LIMITATION: this is memory, not storage. A reload, a closed tab or
 * a second device all start a fresh conversation. Durable, cross-device
 * history needs a server-side store keyed by the signed-in user — specified
 * in docs/agent-conversation-persistence.md, and deliberately left until
 * accounts land, since keying it on a wallet address now would mean
 * re-keying it later.
 *
 * NOT held here: the in-flight offramp's own progress (`offrampStep` and
 * friends in StellarampDashboard). That is not this component's to keep —
 * the server already knows it, and both ramps expose it at
 * /api/{ramp}/stream/[orderId]. Resuming narration after a tab switch is a
 * re-subscription, not a second copy of state that can disagree.
 */
export function AgentConversationProvider({ children }: { readonly children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [GREETING()]);
  const [readCount, setReadCount] = useState(1);
  const [lastCompletedOrder, setLastCompletedOrder] =
    useState<CompletedOrderSummary | null>(null);

  const clear = useCallback(() => {
    const fresh = [GREETING()];
    setMessages(fresh);
    setReadCount(fresh.length);
    // Deliberately kept: "do that again" should still work after a user
    // tidies the thread away. It holds no conversation text, only the
    // fields the parse route needs to rebuild one order.
  }, []);

  const value = useMemo(
    () => ({
      messages,
      setMessages,
      readCount,
      setReadCount,
      lastCompletedOrder,
      setLastCompletedOrder,
      clear,
    }),
    [messages, readCount, lastCompletedOrder, clear],
  );

  return (
    <AgentConversationContext.Provider value={value}>
      {children}
    </AgentConversationContext.Provider>
  );
}

export function useAgentConversation() {
  const value = useContext(AgentConversationContext);
  if (!value) {
    throw new Error("useAgentConversation must be used inside AgentConversationProvider");
  }
  return value;
}
