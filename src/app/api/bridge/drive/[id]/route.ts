import { NextRequest, NextResponse } from "next/server";
import { expectedDriveUrl, handleDrive } from "@/lib/bridge/drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * QStash callback: advances one bridge, then schedules the next rung of the
 * delay ladder (src/lib/bridge/schedule.ts) unless it's final. Signed
 * requests only (QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY);
 * everything is rejected with 401 when the keys are unset.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rawBody = await request.text();
  const r = await handleDrive(
    { pathId: id, rawBody, signature: request.headers.get("upstash-signature") },
    undefined,
    expectedDriveUrl(id),
  );
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
