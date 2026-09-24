import { NextRequest, NextResponse } from "next/server";
import {
  addReadIds,
  clearReadIds,
  getReadIds,
  isValidAddress,
} from "@/lib/notifications/read-store";

// One request can't mark more than this at once. "Mark all as read" sends
// every id it currently shows, which is bounded by the history page size.
const MAX_PER_REQUEST = 500;

/** The ids this wallet has marked read. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    if (!isValidAddress(address)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    return NextResponse.json({ data: { read: await getReadIds(address) } });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to load notification state" },
      { status: 500 },
    );
  }
}

/**
 * `{ add: string[] }` marks those ids read; `{ clear: true }` marks
 * everything unread. Adding rather than replacing is what keeps two devices
 * from overwriting each other's progress.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    if (!isValidAddress(address)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const clear = body?.clear === true;
    const rawAdd: unknown = body?.add;
    const add = Array.isArray(rawAdd)
      ? rawAdd.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200)
      : [];

    if (!clear && add.length === 0) {
      return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
    }
    if (add.length > MAX_PER_REQUEST) {
      return NextResponse.json({ error: "Too many ids" }, { status: 413 });
    }

    // Clear first so `{ clear: true, add: [...] }` means "reset, then mark
    // these" rather than depending on which ran first.
    if (clear) await clearReadIds(address);
    if (add.length > 0) await addReadIds(address, add);

    return NextResponse.json({ data: { read: await getReadIds(address) } });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to save notification state" },
      { status: 500 },
    );
  }
}
