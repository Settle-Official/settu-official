// Core domain types for the offramp system

export type TradeState =
  | "draft"
  | "quoted"
  | "source_tx_submitted"
  | "bridge_pending"
  | "bridge_completed"
  | "payout_order_created"
  | "destination_tx_submitted"
  | "payout_pending"
  | "completed"
  | "failed";

export type BridgeStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

export type PayoutStatus =
  | "pending"
  | "deposited"
  | "validated"
  | "settling"
  | "settled"
  | "refunding"
  | "refunded"
  | "expired"
  | "unknown";

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  contract: string;
  chain: string;
}

export interface QuoteRequest {
  sourceToken: TokenInfo;
  destinationToken: TokenInfo;
  amount: string;
  isFiatInput: boolean;
  currency: string;
}

export interface QuoteResponse {
  sourceAmount: string;
  destinationAmount: string;
  bridgeFee: string;
  payoutFee: string;
  rate: number;
  estimatedTime: number;
  validUntil: Date;
}

export interface BeneficiaryInfo {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  currency: string;
  memo?: string;
  // Pin the order to a single provider, bypassing rate-based routing.
  providerId?: string;
  // Corridor-specific hints Paycrest forwards to the provider (e.g. mobile-money
  // `channel` / `businessNumber`).
  metadata?: Record<string, unknown>;
}

export interface ExecuteRequest {
  quoteId: string;
  sourceAddress: string;
  beneficiary: BeneficiaryInfo;
}

export interface ExecuteResponse {
  tradeId: string;
  state: TradeState;
  sourceTxHash?: string;
  bridgeTransferId?: string;
  payoutOrderId?: string;
  destinationTxHash?: string;
}

export interface TradeStatus {
  tradeId: string;
  state: TradeState;
  sourceTxHash?: string;
  bridgeStatus?: BridgeStatus;
  bridgeTransferId?: string;
  payoutOrderId?: string;
  payoutStatus?: PayoutStatus;
  destinationTxHash?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BridgeTransferRequest {
  amount: string;
  sourceToken: TokenInfo;
  destinationToken: TokenInfo;
  fromAddress: string;
  toAddress: string;
}

export interface BridgeTransferResponse {
  transferId: string;
  status: BridgeStatus;
  estimatedTime: number;
}

export interface PayoutOrderRequest {
  amount: number;
  token: string;
  network: string;
  rate: number;
  recipient: BeneficiaryInfo;
  returnAddress: string;
}

export interface PayoutOrderResponse {
  id: string;
  receiveAddress: string;
  amount: string;
  senderFee: string;
  transactionFee: string;
  validUntil: string;
  status: PayoutStatus;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Onramp (fiat → crypto) — Paycrest v2
// ---------------------------------------------------------------------------

// Lifecycle of an onramp order, from fiat deposit through Stellar delivery.
// The first block mirrors Paycrest's payment_order.* events; the bridge_* /
// delivered states are added by us for the Base→Stellar leg.
export type OnrampStatus =
  | "pending" // order created, awaiting fiat
  | "deposited" // fiat received
  | "validated" // fiat confirmed by provider
  | "settling" // Paycrest releasing USDC onchain (to our Base hot wallet)
  | "settled" // USDC in platform Base hot wallet — bridge can start
  | "bridging" // Base→Stellar bridge submitted
  | "delivered" // USDC delivered to user's Stellar wallet
  | "bridge_failed" // funds held; manual resolution required
  | "refunding"
  | "refunded"
  | "expired"
  | "unknown";

export interface OnrampRefundAccount {
  institution: string;
  accountIdentifier: string;
  accountName: string;
}

export interface CreateOnrampOrderParams {
  fiatAmount: string; // denominated in fiat (amountIn = "fiat")
  currency: string; // NGN, KES, ...
  country?: string; // ISO 3166-1 alpha-2
  recipientAddress: string; // platform Base hot wallet (EVM)
  network?: string; // defaults to "base"
  cryptoCurrency?: string; // defaults to "USDC"
  refundAccount: OnrampRefundAccount;
  rate?: number;
  reference?: string;
}

// The virtual bank account the user deposits fiat into.
export interface OnrampProviderAccount {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  amountToTransfer: string;
  currency: string;
  validUntil: string;
}

export interface OnrampOrderResponse {
  id: string;
  status: string;
  amount: string;
  rate?: string;
  reference?: string;
  providerAccount: OnrampProviderAccount;
}

// ---------------------------------------------------------------------------
// Market book / provider routing — Paycrest v2 `GET /markets`
// ---------------------------------------------------------------------------

export type MarketSide = "sell" | "buy";

/**
 * One row of the market book. Paycrest returns every numeric as a string, so
 * they are kept as strings here and parsed at the point of comparison.
 *
 * A row is a *tier*, not a provider: one providerId appears many times with
 * different min/max bands at different rates.
 */
export interface MarketOffer {
  providerId: string;
  side: MarketSide;
  token: string;
  fiat: string;
  network: string;
  rate: string;
  rateType: string;
  min: string;
  max: string;
  /** Available liquidity — fiat for `sell`, token for `buy`. */
  balance: string;
  balanceCurrency: string;
  balanceUsd: string;
  settled: number;
  /** Null when the provider has no settlement history in this corridor. */
  successPercent: string | null;
}

export interface ProviderSelection {
  /** Ordered fallback queue, best first. Empty when nothing qualifies. */
  providerIds: string[];
  /** Rate of the top-ranked offer; 0 when nothing qualifies. */
  rate: number;
  /** The winning offer per provider, in the same order as `providerIds`. */
  offers: MarketOffer[];
  /** True when the success-rate floor had to be dropped to return anything. */
  relaxedSuccessFloor: boolean;
}

export interface CreateOfframpOrderV2Params {
  amount: number;
  token: string;
  network: string;
  rate: number;
  currency: string;
  recipient: BeneficiaryInfo;
  refundAddress: string;
  reference?: string;
  providerIds?: string[];
}
