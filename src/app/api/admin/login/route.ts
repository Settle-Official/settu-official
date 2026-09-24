import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_MS, passwordToCookie } from "@/lib/admin/auth";

export const runtime = "nodejs";

/** Exchanges the shared admin password for a short-lived signed cookie. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  const cookie = passwordToCookie(password);
  if (!cookie) {
    // Deliberately vague, and deliberately slow-ish: this endpoint guards
    // actions that move money, so it shouldn't help anyone enumerate.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ADMIN_SESSION_MS / 1000),
  });
  return res;
}

/** Sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
