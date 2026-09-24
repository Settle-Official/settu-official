import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { listAdminActions } from "@/lib/admin/audit";

export const runtime = "nodejs";

/**
 * The audit trail. Exists because a log nothing can read is not a log — it
 * was being written and never surfaced, which is the same as not having one.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50));
  try {
    return NextResponse.json({ data: { entries: await listAdminActions(limit) } });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to read audit log" }, { status: 500 });
  }
}
