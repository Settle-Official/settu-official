/**
 * Telegram alerts for the relayer hot wallets running low on gas.
 *
 * Each wallet refuses to send below a floor (see assertBaseGasFloor and
 * assertStellarGasFloor), and a refusal fails the user's order mid-bridge.
 * These alerts are raised from those same checks, which run before every
 * send:
 *
 *   - below the warn level: a warning, so someone tops up before it matters;
 *   - below the floor: a critical alert, because sends are now refused.
 *
 * Each level alerts at most once per throttle window per wallet, tracked in
 * Redis, so a busy hour doesn't flood the chat. Never throws.
 */

import { Redis } from "@upstash/redis";
import { notify } from "./telegram";

export type GasLevel = "ok" | "low" | "empty";

export function gasLevel(balance: number, floor: number, warn: number): GasLevel {
  if (balance < floor) return "empty";
  if (balance < warn) return "low";
  return "ok";
}

/** How long a level stays quiet after alerting. */
const THROTTLE_SECONDS: Record<Exclude<GasLevel, "ok">, number> = {
  low: 6 * 60 * 60,
  empty: 30 * 60,
};

let redis: Redis | null = null;
function getRedis(): Redis {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  return redis;
}

export interface GasReading {
  /** Short stable name, used in the throttle key and the message. */
  readonly wallet: string;
  readonly address: string;
  /** Native gas token ticker (ETH, AVAX, POL, XLM, SOL). */
  readonly unit: string;
  readonly balance: number;
  readonly floor: number;
  readonly warn: number;
}

export function gasAlertMessage(r: GasReading, level: Exclude<GasLevel, "ok">): string {
  const head =
    level === "empty"
      ? `<b>${r.wallet} is out of gas: sends are being refused</b>`
      : `<b>${r.wallet} is running low on gas</b>`;
  return [
    head,
    `Balance: ${r.balance} ${r.unit} (floor ${r.floor}, warn below ${r.warn})`,
    `Top up: <code>${r.address}</code>`,
    level === "empty" &&
      "Orders reaching this wallet will fail until it's topped up; revive them afterwards.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function reportGasBalance(r: GasReading): Promise<void> {
  const level = gasLevel(r.balance, r.floor, r.warn);
  if (level === "ok") return;
  try {
    const first = await getRedis().set(`alert:gas:${r.wallet}:${level}`, "1", {
      nx: true,
      ex: THROTTLE_SECONDS[level],
    });
    if (first !== "OK") return;
    await notify(gasAlertMessage(r, level), level === "empty" ? "critical" : "warning");
  } catch {
    // Best-effort: an alerting failure must never block a send.
  }
}
