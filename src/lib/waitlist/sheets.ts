import { createSign } from "node:crypto";
import { SHEET_HEADERS } from "./schema";

/**
 * Appends waitlist rows to a Google Sheet through the official Sheets API,
 * authenticated as a service account (the sheet is shared with its email).
 * No SDK: a service-account login is one signed JWT exchanged for a token.
 *
 * Env:
 *   GOOGLE_SHEETS_CLIENT_EMAIL — the service account's email
 *   GOOGLE_SHEETS_PRIVATE_KEY  — its private key (PEM; "\n" escapes are fine)
 *   WAITLIST_SHEET_ID          — the id in the sheet's URL
 *   WAITLIST_SHEET_TAB         — tab name (default "Waitlist")
 */

export function sheetsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.WAITLIST_SHEET_ID);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL!;
  const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256"); signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

let headersChecked = false;

export async function appendWaitlistRow(row: string[]): Promise<void> {
  const id = process.env.WAITLIST_SHEET_ID!;
  const tab = process.env.WAITLIST_SHEET_TAB || "Waitlist";
  const range = encodeURIComponent(`${tab}!A1`);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values`;
  const auth = { Authorization: `Bearer ${await accessToken()}` };

  // First write on a fresh tab: put the header row in place.
  if (!headersChecked) {
    const head = await fetch(`${base}/${range}`, { headers: auth });
    if (!head.ok) throw new Error(`Google Sheets read failed (${head.status})`);
    const { values } = (await head.json()) as { values?: string[][] };
    if (!values?.length) await append(base, range, auth, [...SHEET_HEADERS]);
    headersChecked = true;
  }
  await append(base, range, auth, row);
}

async function append(base: string, range: string, auth: Record<string, string>, row: string[]) {
  // RAW: values are stored as typed, never parsed as formulas.
  const res = await fetch(`${base}/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Google Sheets append failed (${res.status})`);
}
