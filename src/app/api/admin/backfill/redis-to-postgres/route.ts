import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";
import { serviceFetch, serviceWrite } from "@/lib/api/server";
import {
  toWire as ledgerToWire,
  type FundsLedgerEntry,
} from "@/lib/ledger/funds-ledger";
import {
  toWire as txToWire,
  type OfframpTransactionRecord,
  type TransactionWire,
} from "@/lib/offramp/transaction-history";

export const runtime = "nodejs";
export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_PAGE = 200;
const STORES = ["ledger", "offramp-transactions"] as const;
type Store = (typeof STORES)[number];

/**
 * Copies the two permanent Redis stores into Postgres, a page at a time.
 *
 * Both writes are idempotent by natural id, so this is safe to re-run — and
 * re-running is the point: it repairs rows whose live dual-write leg was
 * dropped by a sleeping backend. The offramp upsert only applies when the
 * incoming updated_at is newer, so a stale Redis copy can never walk a
 * fresher Postgres row backwards.
 *
 * `?store=ledger|offramp-transactions&offset=&limit=&dryRun=1`
 */
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const store = url.searchParams.get("store") as Store | null;
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100),
  );
  const dryRun = url.searchParams.get("dryRun") === "1";

  if (!store || !STORES.includes(store)) {
    return NextResponse.json(
      { error: `store must be one of: ${STORES.join(", ")}` },
      { status: 400 },
    );
  }

  let audit;
  try {
    audit = await requireAdmin(request, "backfill.redis_to_postgres", {
      store,
      offset,
      limit,
      dryRun,
    });
  } catch {
    // Fails closed, and bulk data movement is exactly what an audit log is for.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result =
    store === "ledger"
      ? await backfillLedger(offset, limit, dryRun)
      : await backfillTransactions(offset, limit, dryRun);

  const body = {
    store,
    dryRun,
    offset,
    limit,
    ...result,
    // Page again from here while this is non-null.
    nextOffset: result.scanned === limit ? offset + limit : null,
  };
  recordOutcome(audit.auditId, "ok", body);
  return NextResponse.json(body);
}

interface PageResult {
  scanned: number;
  written: number;
  alreadyPresent: number;
  missingInRedis: number;
  failed: number;
}

async function backfillLedger(
  offset: number,
  limit: number,
  dryRun: boolean,
): Promise<PageResult> {
  const ids = await redis.zrange<string[]>(
    "ledger:index",
    offset,
    offset + limit - 1,
    { rev: true },
  );
  const entries = await Promise.all(
    ids.map((id) => redis.get<FundsLedgerEntry>(`ledger:entry:${id}`)),
  );

  const result: PageResult = {
    scanned: ids.length,
    written: 0,
    alreadyPresent: 0,
    missingInRedis: 0,
    failed: 0,
  };

  for (const entry of entries) {
    if (!entry) {
      result.missingInRedis++;
      continue;
    }
    if (dryRun) {
      result.written++;
      continue;
    }
    // Reported rather than swallowed here: unlike the live dual-write leg,
    // a failure during a backfill is the thing the operator needs to see.
    try {
      const response = await serviceFetch<{ created: boolean }>(
        "/ledger/entries",
        { method: "POST", body: ledgerToWire(entry) },
      );
      if (response.created) result.written++;
      else result.alreadyPresent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

async function backfillTransactions(
  offset: number,
  limit: number,
  dryRun: boolean,
): Promise<PageResult> {
  const ids = await redis.zrange<string[]>(
    "offramp:tx:index",
    offset,
    offset + limit - 1,
    { rev: true },
  );
  const records = await Promise.all(
    ids.map((id) => redis.get<OfframpTransactionRecord>(`offramp:tx:${id}`)),
  );

  const result: PageResult = {
    scanned: ids.length,
    written: 0,
    alreadyPresent: 0,
    missingInRedis: 0,
    failed: 0,
  };

  for (const record of records) {
    if (!record) {
      result.missingInRedis++;
      continue;
    }
    if (dryRun) {
      result.written++;
      continue;
    }
    const wire: TransactionWire = txToWire(record);
    const ok = await serviceWrite("/offramp/transactions", wire);
    if (ok) result.written++;
    else result.failed++;
  }
  return result;
}
