/**
 * Pure display helpers for the admin bridge explorer. No server imports, so
 * the client component and the tests can both use them.
 */

import { formatAtomic } from "./admin-units";

export type PillStatus = "submitted" | "verifying" | "delivering" | "completed" | "failed" | "stuck";

/** The status pill: a stuck bridge shows "Stuck" regardless of its stage. */
export function pillStatus(row: { status: string; stuck: boolean }): PillStatus {
  return row.stuck ? "stuck" : (row.status as PillStatus);
}

/** 6-decimal atomic string → "1.234567" (trailing zeros trimmed). */
export const usdc = (atomic: string): string => formatAtomic(atomic, 6);

export function nativeAmount(atomic: string, decimals: number, symbol: string): string {
  return `${formatAtomic(atomic, decimals)} ${symbol}`.trim();
}

export interface AddressView {
  text: string;
  tag?: "token account";
  unknown?: boolean;
}

/** User's real destination: the recipient, never the bytes32 mint recipient. */
export function recipientView(row: {
  recipient?: string;
  recipientIsTokenAccount?: boolean;
  recipientUnknown?: boolean;
}): AddressView {
  if (row.recipientUnknown || !row.recipient) {
    return { text: "Unknown (recovered by sweep)", unknown: true };
  }
  return row.recipientIsTokenAccount
    ? { text: row.recipient, tag: "token account" }
    : { text: row.recipient };
}

export const shortAddr = (s: string): string => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Poll only while the tab is visible. */
export const shouldPoll = (visibility: string): boolean => visibility === "visible";
