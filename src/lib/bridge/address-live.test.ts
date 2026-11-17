import { test } from "node:test";
import assert from "node:assert/strict";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  checkDestinationLive,
  deriveUsdcAta,
  type LiveCheckDeps,
} from "./address-live";
import { CCTP_CONFIG } from "../cctp/constants";

const PASS = CCTP_CONFIG.stellarNetworkPassphrase;
const ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();
const USDC_SAC = new Asset("USDC", ISSUER).contractId(PASS);
const G = Keypair.random().publicKey();
const SOL_WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SYSTEM = "11111111111111111111111111111111";

function deps(over: Partial<LiveCheckDeps> = {}): LiveCheckDeps {
  return {
    stellarAccount: async () => {
      throw new Error("stellarAccount not stubbed");
    },
    solanaAccountOwner: async () => {
      throw new Error("solanaAccountOwner not stubbed");
    },
    stellarUsdcContractId: USDC_SAC,
    ...over,
  };
}

function usdcLine(issuer: string, extra: Record<string, unknown> = {}) {
  return {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: issuer,
    balance: "0.0000000",
    is_authorized: true,
    ...extra,
  };
}
const XLM_LINE = { asset_type: "native", balance: "10.0000000" };

// ------------------------------------------------------------- Solana ATA

test("deriveUsdcAta matches @solana/spl-token's getAssociatedTokenAddressSync", () => {
  // Vectors computed with spl-token 0.3.11 getAssociatedTokenAddressSync.
  assert.equal(
    deriveUsdcAta(SOL_WALLET, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    "42JrewdefrETKYFymk8F8FCtJSxLpQQjSyLb4GwueWHG",
  );
  assert.equal(
    deriveUsdcAta(SOL_WALLET, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    "CLTcs7gP4PLPaU5uLQ7oCsgAhXg9aQHXfM5rXkyXWZqi",
  );
});

// ------------------------------------------------------------- Stellar

test("Stellar: unknown account -> no_account", async () => {
  const r = await checkDestinationLive("stellar", G, deps({ stellarAccount: async () => null }));
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "no_account");
});

test("Stellar: account without a USDC trustline -> no_trustline", async () => {
  const r = await checkDestinationLive(
    "stellar",
    G,
    deps({ stellarAccount: async () => ({ balances: [XLM_LINE] }) }),
  );
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "no_trustline");
  assert.match((r as { message: string }).message, /trustline/i);
});

test("Stellar: a USDC trustline from a different issuer -> no_trustline", async () => {
  const r = await checkDestinationLive(
    "stellar",
    G,
    deps({ stellarAccount: async () => ({ balances: [XLM_LINE, usdcLine(OTHER_ISSUER)] }) }),
  );
  assert.equal((r as { code: string }).code, "no_trustline");
});

test("Stellar: an unauthorized USDC trustline -> no_trustline", async () => {
  const r = await checkDestinationLive(
    "stellar",
    G,
    deps({
      stellarAccount: async () => ({ balances: [usdcLine(ISSUER, { is_authorized: false })] }),
    }),
  );
  assert.equal((r as { code: string }).code, "no_trustline");
});

test("Stellar: account with the chain's USDC trustline -> ok", async () => {
  let asked = "";
  const r = await checkDestinationLive(
    "stellar",
    G,
    deps({
      stellarAccount: async (g) => {
        asked = g;
        return { balances: [XLM_LINE, usdcLine(ISSUER)] };
      },
    }),
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(asked, G);
});

test("Stellar: a Horizon failure propagates (fail closed)", async () => {
  await assert.rejects(
    checkDestinationLive(
      "stellar",
      G,
      deps({
        stellarAccount: async () => {
          throw new Error("Horizon 503");
        },
      }),
    ),
  );
});

// ------------------------------------------------------------- Solana

test("Solana: wallet without a USDC ATA -> ok with needsSolanaAta", async () => {
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const ata = deriveUsdcAta(SOL_WALLET, usdcMint);
  const r = await checkDestinationLive(
    "solana",
    SOL_WALLET,
    deps({
      solanaUsdcMint: usdcMint,
      solanaAccountOwner: async (a) => (a === SOL_WALLET ? SYSTEM : null),
    }),
  );
  assert.deepEqual(r, { ok: true, solanaAta: ata, needsSolanaAta: true });
});

test("Solana: wallet with an existing ATA -> ok, needsSolanaAta false", async () => {
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const ata = deriveUsdcAta(SOL_WALLET, usdcMint);
  const r = await checkDestinationLive(
    "solana",
    SOL_WALLET,
    deps({
      solanaUsdcMint: usdcMint,
      solanaAccountOwner: async (a) =>
        a === SOL_WALLET ? SYSTEM : a === ata ? SPL_TOKEN_PROGRAM_ID : null,
    }),
  );
  assert.deepEqual(r, { ok: true, solanaAta: ata, needsSolanaAta: false });
});

test("Solana: a brand-new (unfunded) wallet is fine", async () => {
  const r = await checkDestinationLive(
    "solana",
    SOL_WALLET,
    deps({ solanaAccountOwner: async () => null }),
  );
  assert.equal(r.ok, true);
  assert.equal((r as { needsSolanaAta?: boolean }).needsSolanaAta, true);
});

test("Solana: a pasted USDC token account -> token_account with the exact message", async () => {
  // The ATA itself is what a user copies from a block explorer by mistake.
  const pasted = deriveUsdcAta(SOL_WALLET, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  for (const owner of [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await checkDestinationLive(
      "solana",
      pasted,
      deps({ solanaAccountOwner: async (a) => (a === pasted ? owner : null) }),
    );
    assert.deepEqual(r, {
      ok: false,
      code: "token_account",
      message: "That's a USDC token account. Paste the wallet address instead.",
    });
  }
});

test("Solana: an RPC failure propagates (fail closed)", async () => {
  await assert.rejects(
    checkDestinationLive(
      "solana",
      SOL_WALLET,
      deps({
        solanaAccountOwner: async () => {
          throw new Error("rpc down");
        },
      }),
    ),
  );
});

// ------------------------------------------------------------- EVM

test("EVM: no live check", async () => {
  const r = await checkDestinationLive(
    "base",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    deps(),
  );
  assert.deepEqual(r, { ok: true });
});

test("SPL program ids are the canonical ones", () => {
  assert.equal(new PublicKey(SPL_TOKEN_PROGRAM_ID).toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.equal(new PublicKey(TOKEN_2022_PROGRAM_ID).toBase58(), "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
});

test("Solana: a program-owned (non-token) account -> not_wallet", async () => {
  const r = await checkDestinationLive(
    "solana",
    SOL_WALLET,
    deps({ solanaAccountOwner: async (a) => (a === SOL_WALLET ? "Stake11111111111111111111111111111111111111" : null) }),
  );
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "not_wallet");
});
