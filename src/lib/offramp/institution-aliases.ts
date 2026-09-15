/**
 * Free-text nicknames for Nigerian banks that share no substring with
 * Paycrest's own institution name, so the exact/substring matching in
 * agent-resolver.ts can never catch them on its own. Confirmed against the
 * live Paycrest NGN institution list (`GET /v1/institutions/NGN`): "GTBank"
 * has zero textual overlap with the real name "Guaranty Trust Bank", "UBA"
 * with "United Bank for Africa", "9PSB" with "9 Payment Service Bank".
 *
 * Most other common nicknames (Access, Zenith, Kuda, Moniepoint, Stanbic,
 * FCMB — which is the official Paycrest name, not an abbreviation of it —
 * ...) already substring-match the real name today and don't need an entry
 * here. Only add one when a real gap is reported, the same way
 * burn-backstop.ts documents its own "extend here if it proves
 * insufficient" scope — this is a short list of confirmed exceptions, not
 * an attempt at a full bank directory.
 *
 * Keyed by the alias with everything but letters/digits stripped and
 * lowercased, so "GT Bank", "gt-bank" and "GTBANK" all hit the same entry.
 * Each value is plain text chosen to be an UNAMBIGUOUS substring of exactly
 * one real institution name (e.g. "9 payment service" rather than "payment
 * service", which also appears in "Hope Payment Service Bank" and others) —
 * agent-resolver.ts's existing exact/substring matching does the actual
 * lookup against it.
 */
const ALIASES: Record<string, string> = {
  gtbank: "guaranty trust",
  gtb: "guaranty trust",
  uba: "united bank",
  "9psb": "9 payment service",
  firstbank: "first bank",
};

export function resolveInstitutionAlias(freeText: string): string | null {
  const key = freeText.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[key] ?? null;
}
