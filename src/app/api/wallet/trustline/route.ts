import { NextRequest, NextResponse } from "next/server";
import { Asset, StrKey } from "@stellar/stellar-sdk";
import {
  SponsorUnavailableError,
  isSponsoredByUs,
  signSponsoredTrustline,
} from "@/lib/settu-wallet/sponsor";
import { describeAsset } from "@/lib/settu-wallet/asset-info";

export const runtime = "nodejs";

// Stellar's own limit; rejecting early beats a confusing Horizon error.
const MAX_CODE_LENGTH = 12;

/** Returns a sponsor-signed trustline XDR plus what we know about the issuer. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const publicKey = String(body?.publicKey ?? "").trim();
  const code = String(body?.assetCode ?? "").trim();
  const issuer = String(body?.assetIssuer ?? "").trim();

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json({ error: "Invalid account" }, { status: 400 });
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    return NextResponse.json({ error: "Invalid issuer" }, { status: 400 });
  }
  if (!code || code.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9]+$/.test(code)) {
    return NextResponse.json({ error: "Invalid asset code" }, { status: 400 });
  }

  // We only pay reserves for our own accounts.
  if (!(await isSponsoredByUs(publicKey))) {
    return NextResponse.json(
      { error: "That account is not a Settu wallet" },
      { status: 403 },
    );
  }

  try {
    const [xdr, asset] = await Promise.all([
      signSponsoredTrustline(publicKey, new Asset(code, issuer)),
      describeAsset(code, issuer),
    ]);
    // The assessment rides along so the UI can warn before the user signs.
    return NextResponse.json({ xdr, asset });
  } catch (error) {
    if (error instanceof SponsorUnavailableError) {
      console.error("[wallet] sponsor unavailable:", error.message);
      return NextResponse.json(
        { error: "Adding assets is temporarily unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}
