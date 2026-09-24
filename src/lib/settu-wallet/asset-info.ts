// Facts about an asset's issuer, so the user can judge a trustline.
// Assets on Stellar are impersonated by code alone, so code is never enough.

import { STELLAR_HORIZON_URL, STELLAR_USDC_ISSUER } from "./account";

export interface AssetAssessment {
  code: string;
  issuer: string;
  /** Set by the issuer and verifiable via its stellar.toml; absent is a flag. */
  homeDomain: string | null;
  holders: number;
  /** Pinned assets we ship a default trustline for. */
  isPinned: boolean;
  /** Not a verdict — the UI still shows the facts behind it. */
  looksEstablished: boolean;
}

// A real asset accumulates holders; an impostor minted yesterday does not.
// Deliberately low, because this informs a warning rather than a block.
const ESTABLISHED_HOLDERS = 1000;

const PINNED_ISSUERS = new Set([STELLAR_USDC_ISSUER]);

/** Pure so the thresholds are testable without Horizon. */
export function assess(
  code: string,
  issuer: string,
  homeDomain: string | null,
  holders: number,
): AssetAssessment {
  const isPinned = PINNED_ISSUERS.has(issuer);
  return {
    code,
    issuer,
    homeDomain,
    holders,
    isPinned,
    looksEstablished:
      isPinned || (Boolean(homeDomain) && holders >= ESTABLISHED_HOLDERS),
  };
}

export async function describeAsset(
  code: string,
  issuer: string,
): Promise<AssetAssessment> {
  const [account, assets] = await Promise.all([
    fetch(`${STELLAR_HORIZON_URL}/accounts/${issuer}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(
      `${STELLAR_HORIZON_URL}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${issuer}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const record = assets?._embedded?.records?.[0];
  const holders = Number(record?.accounts?.authorized ?? 0);
  return assess(code, issuer, account?.home_domain ?? null, holders);
}
