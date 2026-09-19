/**
 * Client-side transaction storage using localStorage
 * Simple solution for storing transaction history without a database
 */

export interface Transaction {
  id: string;
  timestamp: number;
  userAddress: string;
  /** USDC amount. */
  amount: string;
  currency: string;
  /** Absent on rows written before this field existed — those are offramps. */
  kind?: "offramp" | "onramp";
  /** Which surface started it: the form/panel, or Agent Mode. */
  initiator?: "form" | "agent";
  /** Onramp only: the fiat the user paid in (`currency` names its unit). */
  fiatAmount?: string;
  stellarTxHash?: string;
  bridgeStatus?: string;
  payoutOrderId?: string;
  payoutStatus?: string;
  beneficiary: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
    currency: string;
  };
  status: "pending" | "completed" | "failed";
  error?: string;
}

const STORAGE_KEY = "stellaramp_transactions";
const MAX_TRANSACTIONS = 50; // Keep last 50 transactions

export class TransactionStorage {
  /**
   * Save a new transaction
   */
  static save(transaction: Transaction): void {
    if (typeof window === "undefined") return;

    const transactions = this.getAll();
    transactions.unshift(transaction);

    // Keep only the most recent transactions
    const trimmed = transactions.slice(0, MAX_TRANSACTIONS);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  }

  /**
   * Update an existing transaction
   */
  static update(id: string, updates: Partial<Transaction>): void {
    if (typeof window === "undefined") return;

    const transactions = this.getAll();
    const index = transactions.findIndex((tx) => tx.id === id);

    if (index !== -1) {
      transactions[index] = { ...transactions[index], ...updates };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
    }
  }

  /** Update the row that tracks a provider order (onramp/offramp order id). */
  static updateByOrderId(orderId: string, updates: Partial<Transaction>): void {
    const match = this.getAll().find((tx) => tx.payoutOrderId === orderId);
    if (match) this.update(match.id, updates);
  }

  /**
   * Get all transactions
   */
  static getAll(): Transaction[] {
    if (typeof window === "undefined") return [];

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get transactions for a specific user
   */
  static getByUser(userAddress: string): Transaction[] {
    return this.getAll().filter(
      (tx) => tx.userAddress.toLowerCase() === userAddress.toLowerCase()
    );
  }

  /**
   * Get a single transaction by ID
   */
  static getById(id: string): Transaction | undefined {
    return this.getAll().find((tx) => tx.id === id);
  }

  /**
   * Clear all transactions
   */
  static clear(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Generate a unique transaction ID
   */
  static generateId(): string {
    return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
