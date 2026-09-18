// Outbound side of the WhatsApp Business Cloud API.

const GRAPH_VERSION = "v21.0";

/** Verifies Meta's webhook signature over the raw body. */
export async function isValidSignature(
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  // Unconfigured means we cannot verify, so nothing is trusted.
  if (!appSecret || !header?.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected = Array.from(new Uint8Array(mac), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  return timingSafeEqual(expected, header.slice("sha256=".length));
}

/** Comparison time must not depend on how much of the digest matched. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sendMessage(to: string, body: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return false;

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  ).catch(() => null);

  return Boolean(res?.ok);
}
