// WebAuthn PRF gives a stable per-credential secret, used only to wrap the DEK.
// The passkey never touches Stellar; the device authenticates, it does not sign.

const PRF_SALT = new TextEncoder().encode("settu-wallet-dek-v1");

function toB64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function"
  );
}

interface PrfExtension {
  prf?: { results?: { first?: ArrayBuffer } };
}

export interface PasskeyWrapSecret {
  credentialId: string;
  secret: string;
}

// Registration often cannot return PRF output, so this asserts immediately
// afterwards to read it.
export async function registerPasskey(
  userId: string,
  userName: string,
): Promise<PasskeyWrapSecret> {
  if (!isPasskeySupported()) throw new Error("Passkeys aren't supported here");

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Settu", id: window.location.hostname },
      user: {
        id: new TextEncoder().encode(userId),
        name: userName,
        displayName: userName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;

  if (!created) throw new Error("Passkey setup was cancelled");
  const credentialId = toB64Url(created.rawId);
  return { credentialId, secret: await readPrf(credentialId) };
}

/** Prompts for the passkey and returns the same secret it produced at setup. */
export async function unlockWithPasskey(
  credentialId: string,
): Promise<string> {
  if (!isPasskeySupported()) throw new Error("Passkeys aren't supported here");
  return readPrf(credentialId);
}

async function readPrf(credentialId: string): Promise<string> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      allowCredentials: [
        { type: "public-key", id: fromB64Url(credentialId) as BufferSource },
      ],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Passkey was cancelled");
  const results = (
    assertion.getClientExtensionResults() as PrfExtension
  ).prf?.results?.first;

  // Falling back silently would wrap the DEK under something guessable.
  if (!results) {
    throw new Error(
      "This device can't derive a wallet key from its passkey. Use your password instead.",
    );
  }
  return toB64Url(results);
}
