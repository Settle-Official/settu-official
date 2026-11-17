import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildQuote,
  deserializeQuote,
  httpStatusFor,
  QUOTE_UNAVAILABLE_MESSAGE,
  type BuildQuoteDeps,
  type QuoteRequest,
  type QuoteSuccess,
} from "./build-quote";
import {
  ed25519PublicKeyFromSeed,
  encodeQuoteBytes,
  recoverEvmQuoteSigner,
  verifyEd25519Quote,
} from "./quote";
import { TEST_ONLY_ED25519_SEED, TEST_ONLY_EVM_PRIVATE_KEY } from "./quote-vectors.test-helper";
import { NetworkFeeUnavailableError } from "./network-fee";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { buildForwarderHookData, contractStrkeyToBytes32Hex } from "../cctp/address-encoding";
import { CCTP_CONFIG } from "../cctp/constants";

const NOW = 1_800_000_000;
const EVM_USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EVM_RECIPIENT = "0x52908400098527886E0F7030069857D2E4169EE7";
const G_USER = Keypair.random().publicKey();
const G_RECIPIENT = Keypair.random().publicKey();
const SOL_USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_RECIPIENT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SOL_ATA = "42JrewdefrETKYFymk8F8FCtJSxLpQQjSyLb4GwueWHG";
const EVM_CONTRACT = "0x000000000000000000000000000000000000bEEF";
const STELLAR_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const SOLANA_PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const NONCE = new Uint8Array(32).fill(0xcd);

const contracts: Record<BridgeChainKey, string> = {
  stellar: STELLAR_CONTRACT,
  ethereum: EVM_CONTRACT,
  base: EVM_CONTRACT,
  arbitrum: EVM_CONTRACT,
  optimism: EVM_CONTRACT,
  avalanche: EVM_CONTRACT,
  polygon: EVM_CONTRACT,
  solana: SOLANA_PROGRAM,
};

function deps(over: Partial<BuildQuoteDeps> = {}): Partial<BuildQuoteDeps> {
  return {
    now: () => NOW,
    randomBytes: () => NONCE,
    getFeeBps: async (speed) => (speed === "fast" ? 60 : 30),
    maxFeeBps: () => 100,
    getFastFeeBps: async () => 1.3,
    estimateNetworkFee: async () => ({ usdcAtomic: BigInt(630_000), nativeAtomic: BigInt(7_000) }),
    checkDestinationLive: async (chain) =>
      chain === "solana"
        ? { ok: true, solanaAta: SOL_ATA, needsSolanaAta: true }
        : { ok: true },
    nativeBalance: async () => {
      throw new Error("nativeBalance should not be called in usdc mode");
    },
    ownGasAllowance: async () => BigInt(0),
    bridgeContractFor: (c) => contracts[c],
    evmSignerKey: () => TEST_ONLY_EVM_PRIVATE_KEY,
    ed25519SignerSecret: () => TEST_ONLY_ED25519_SEED,
    saveQuoteRecord: async () => {},
    ...over,
  };
}

const baseReq: QuoteRequest = {
  source: "base",
  dest: "arbitrum",
  amount: "100",
  speed: "standard",
  user: EVM_USER,
  recipient: EVM_RECIPIENT,
  networkFeeMode: "usdc",
};

function ok(r: Awaited<ReturnType<typeof buildQuote>>): QuoteSuccess {
  if ("error" in r) assert.fail(`expected a quote, got ${r.code}: ${r.error}`);
  return r;
}
function err(r: Awaited<ReturnType<typeof buildQuote>>) {
  assert.ok("error" in r, "expected an error");
  return r as { error: string; code: string };
}

const noSign: Partial<BuildQuoteDeps> = {
  evmSignerKey: () => assert.fail("must not sign"),
  ed25519SignerSecret: () => assert.fail("must not sign"),
};

// ------------------------------------------------------------- validation

test("refuses to sign when validateDestinationAddress fails", async () => {
  const r = err(await buildQuote({ ...baseReq, recipient: G_RECIPIENT }, deps(noSign)));
  assert.equal(r.code, "wrong_family");
  const r2 = err(await buildQuote({ ...baseReq, recipient: "0x1234" }, deps(noSign)));
  assert.equal(r2.code, "bad_format");
  // The chain's own USDC contract is forbidden as a recipient.
  const r3 = err(
    await buildQuote({ ...baseReq, recipient: BRIDGE_CHAINS.arbitrum.usdc }, deps(noSign)),
  );
  assert.equal(r3.code, "forbidden");
});

test("refuses when the live check fails", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, dest: "stellar", recipient: G_RECIPIENT },
      deps({
        ...noSign,
        checkDestinationLive: async () => ({ ok: false, code: "no_trustline", message: "x" }),
      }),
    ),
  );
  assert.equal(r.code, "no_trustline");
  assert.equal(httpStatusFor(r.code), 400);
});

test("same-chain source and dest -> error", async () => {
  const r = err(await buildQuote({ ...baseReq, dest: "base" }, deps(noSign)));
  assert.equal(r.code, "same_chain");
  assert.equal(httpStatusFor(r.code), 400);
});

test("rejects an invalid or mismatched source address", async () => {
  for (const user of [G_USER, SOL_USER, "0xnothex", ""]) {
    const r = err(await buildQuote({ ...baseReq, user }, deps(noSign)));
    assert.equal(r.code, "invalid_source", user);
  }
  const r = err(await buildQuote({ ...baseReq, source: "stellar", user: EVM_USER }, deps(noSign)));
  assert.equal(r.code, "invalid_source");
});

test("rejects unknown chains, speeds, fee modes and bad amounts", async () => {
  const bad: Partial<Record<keyof QuoteRequest, unknown>>[] = [
    { source: "bitcoin" },
    { dest: "toString" },
    { speed: "instant" },
    { networkFeeMode: "eth" },
    { amount: 100 },
  ];
  for (const b of bad) {
    const r = err(await buildQuote({ ...baseReq, ...b } as unknown as QuoteRequest, deps(noSign)));
    assert.equal(httpStatusFor(r.code), 400, JSON.stringify(b));
  }
  const r = err(await buildQuote({ ...baseReq, amount: "abc" }, deps(noSign)));
  assert.equal(r.code, "invalid_amount");
});

// ------------------------------------------------------------- fee setting

test("the fee setting is read from getBridgeFeeBps for the requested speed", async () => {
  const asked: string[] = [];
  const r = ok(
    await buildQuote(
      { ...baseReq, speed: "standard" },
      deps({
        getFeeBps: async (speed) => {
          asked.push(speed);
          return 45;
        },
      }),
    ),
  );
  assert.deepEqual(asked, ["standard"]);
  // 100 USDC * 45 bps = 0.45 USDC
  assert.equal(r.breakdown.settuFeeShownAtomic, "450000");
  assert.equal(r.quote.settuFee, "450000");
});

test("default getFeeBps is getBridgeFeeBps (via the injected reader)", async () => {
  // Without a getFeeBps override, the default calls getBridgeFeeBps with the
  // reader from deps.feeReader; a stored 50 must reach the breakdown.
  const keys: string[] = [];
  const d = deps();
  delete d.getFeeBps;
  const r = ok(
    await buildQuote(baseReq, {
      ...d,
      feeReader: async (key) => {
        keys.push(key);
        return 50;
      },
    }),
  );
  assert.deepEqual(keys, ["bridge:fee-bps:standard"]);
  assert.equal(r.breakdown.settuFeeShownAtomic, "500000");
});

test("fee_config: a stored fee above the cap is refused, never clamped", async () => {
  for (const bps of [150, 30.5, -1, Number.NaN]) {
    const r = err(await buildQuote(baseReq, deps({ ...noSign, getFeeBps: async () => bps })));
    assert.equal(r.code, "fee_config", String(bps));
    assert.equal(httpStatusFor(r.code), 503);
  }
});

test("fee_config: BRIDGE_MAX_FEE_BPS env is read, and a bad value refuses", async () => {
  const saved = process.env.BRIDGE_MAX_FEE_BPS;
  const d = deps({ ...noSign, getFeeBps: async () => 40 });
  delete d.maxFeeBps;
  try {
    process.env.BRIDGE_MAX_FEE_BPS = "35";
    assert.equal(err(await buildQuote(baseReq, d)).code, "fee_config");
    process.env.BRIDGE_MAX_FEE_BPS = "abc";
    assert.equal(err(await buildQuote(baseReq, d)).code, "fee_config");
    delete process.env.BRIDGE_MAX_FEE_BPS; // default cap 100
    const r = await buildQuote(baseReq, { ...d, ...deps({ getFeeBps: async () => 40 }), maxFeeBps: undefined });
    assert.ok(!("error" in r));
  } finally {
    if (saved === undefined) delete process.env.BRIDGE_MAX_FEE_BPS;
    else process.env.BRIDGE_MAX_FEE_BPS = saved;
  }
});

// ------------------------------------------------------------- EVM source

test("EVM source: signature recovers to the signer; deadline - now === 120", async () => {
  const r = ok(await buildQuote(baseReq, deps()));
  assert.equal(r.quote.deadline - NOW, 120);
  assert.equal(r.expiresAt, r.quote.deadline);
  assert.equal(r.contract, EVM_CONTRACT);
  const q = deserializeQuote(r.quote);
  const signer = await recoverEvmQuoteSigner(
    q,
    BRIDGE_CHAINS.base.chainId!,
    EVM_CONTRACT,
    r.signature as `0x${string}`,
  );
  assert.equal(signer, privateKeyToAccount(TEST_ONLY_EVM_PRIVATE_KEY).address);
  // A tampered fee no longer recovers to the signer.
  const tampered = await recoverEvmQuoteSigner(
    { ...q, settuFee: q.settuFee + BigInt(1) },
    BRIDGE_CHAINS.base.chainId!,
    EVM_CONTRACT,
    r.signature as `0x${string}`,
  );
  assert.notEqual(tampered, signer);
});

test("EVM source/dest: fields of the signed quote", async () => {
  const r = ok(await buildQuote(baseReq, deps()));
  assert.equal(r.quote.version, 1);
  assert.equal(r.quote.sourceDomain, BRIDGE_CHAINS.base.cctpDomain);
  assert.equal(r.quote.destDomain, BRIDGE_CHAINS.arbitrum.cctpDomain);
  assert.equal(r.quote.user, EVM_USER);
  assert.equal(r.quote.amount, "100000000");
  assert.equal(r.quote.settuFee, "300000");
  assert.equal(r.quote.networkFee, "630000");
  assert.equal(r.quote.nativeFee, "0");
  assert.equal(r.quote.maxFee, "0");
  assert.equal(r.quote.minFinality, 2000);
  assert.equal(r.quote.mintRecipient, `0x${"0".repeat(24)}${EVM_RECIPIENT.slice(2).toLowerCase()}`);
  assert.equal(r.quote.hookData, "0x");
  assert.equal(r.quote.nonce, `0x${"cd".repeat(32)}`);
  assert.equal(r.breakdown.receiveAtomic, "99070000");
  assert.equal(r.breakdown.receiveIsMinimum, false);
});

test("Fast: maxFee = fastFeeMaxAtomic, minFinality 1000, settuFee net of it", async () => {
  const pairs: unknown[] = [];
  const r = ok(
    await buildQuote(
      { ...baseReq, speed: "fast" },
      deps({
        getFastFeeBps: async (p) => {
          pairs.push(p);
          return 1.3;
        },
      }),
    ),
  );
  assert.deepEqual(pairs, [{ sourceDomain: 6, destDomain: 3 }]);
  assert.equal(r.quote.minFinality, 1000);
  assert.equal(r.quote.maxFee, r.breakdown.fastFeeMaxAtomic);
  assert.equal(r.quote.maxFee, "13000");
  assert.equal(r.quote.settuFee, String(600_000 - 13_000));
});

test("fast_unavailable -> 409", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, speed: "fast" },
      deps({ ...noSign, getFastFeeBps: async () => 80 }),
    ),
  );
  assert.equal(r.code, "fast_unavailable");
  assert.equal(httpStatusFor(r.code), 409);
});

test("an amount too small for the fees -> 400", async () => {
  const r = err(await buildQuote({ ...baseReq, amount: "0.5" }, deps(noSign)));
  assert.equal(r.code, "invalid_amount");
});

// ------------------------------------------------------------- fail closed

test("NetworkFeeUnavailableError -> unavailable with the no-quote copy (503)", async () => {
  const r = err(
    await buildQuote(
      baseReq,
      deps({
        ...noSign,
        estimateNetworkFee: async () => {
          throw new NetworkFeeUnavailableError("no price");
        },
      }),
    ),
  );
  assert.equal(r.code, "unavailable");
  assert.equal(r.error, QUOTE_UNAVAILABLE_MESSAGE);
  assert.equal(QUOTE_UNAVAILABLE_MESSAGE, "Couldn't get a price right now — try again in a moment");
  assert.equal(httpStatusFor(r.code), 503);
});

test("an Iris failure -> unavailable (503)", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, speed: "fast" },
      deps({
        ...noSign,
        getFastFeeBps: async () => {
          throw new Error("Iris fee quote failed: 500");
        },
      }),
    ),
  );
  assert.equal(r.code, "unavailable");
  assert.equal(r.error, QUOTE_UNAVAILABLE_MESSAGE);
});

test("a live-check RPC failure -> unavailable, never signed", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, dest: "solana", recipient: SOL_RECIPIENT },
      deps({
        ...noSign,
        checkDestinationLive: async () => {
          throw new Error("rpc down");
        },
      }),
    ),
  );
  assert.equal(r.code, "unavailable");
});

// ------------------------------------------------------------- destinations

test("Solana destination: mintRecipient is the recipient's USDC ATA; ATA rent requested", async () => {
  const feeOpts: unknown[] = [];
  const r = ok(
    await buildQuote(
      { ...baseReq, dest: "solana", recipient: SOL_RECIPIENT },
      deps({
        estimateNetworkFee: async (dest, source, opts) => {
          feeOpts.push([dest, source, opts]);
          return { usdcAtomic: BigInt(630_000), nativeAtomic: BigInt(7_000) };
        },
      }),
    ),
  );
  assert.equal(r.quote.mintRecipient, `0x${Buffer.from(new PublicKey(SOL_ATA).toBytes()).toString("hex")}`);
  assert.equal(r.quote.hookData, "0x");
  assert.deepEqual(feeOpts, [["solana", "base", { needsSolanaAta: true }]]);
});

test("Solana destination without an ATA from the live check -> refuses (internal)", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, dest: "solana", recipient: SOL_RECIPIENT },
      deps({ ...noSign, checkDestinationLive: async () => ({ ok: true }) }),
    ),
  );
  assert.equal(r.code, "internal");
});

test("Stellar destination: forwarder as mintRecipient, recipient in hookData", async () => {
  const r = ok(await buildQuote({ ...baseReq, dest: "stellar", recipient: G_RECIPIENT }, deps()));
  assert.equal(r.quote.mintRecipient, contractStrkeyToBytes32Hex(CCTP_CONFIG.stellarCctpForwarder));
  assert.equal(r.quote.hookData, buildForwarderHookData(G_RECIPIENT));
});

// ------------------------------------------------------------- Stellar source (Ruling J)

test("Stellar source: signed amounts are x10 (7-dp); breakdown stays 6-dp; ed25519 verifies", async () => {
  const r = ok(
    await buildQuote(
      {
        source: "stellar",
        dest: "base",
        amount: "100.1234567", // 7th decimal dropped by the breakdown
        speed: "fast",
        user: G_USER,
        recipient: EVM_RECIPIENT,
        networkFeeMode: "usdc",
      },
      deps(),
    ),
  );
  const b = r.breakdown;
  assert.equal(b.sendAtomic, "100123456");
  assert.equal(r.quote.amount, "1001234560");
  assert.equal(r.quote.settuFee, String(BigInt(b.settuFeeAtomic) * BigInt(10)));
  assert.equal(r.quote.networkFee, String(BigInt(b.networkFeeAtomic) * BigInt(10)));
  assert.equal(r.quote.maxFee, String(BigInt(b.fastFeeMaxAtomic) * BigInt(10)));
  assert.notEqual(r.quote.maxFee, "0");
  assert.equal(r.quote.nativeFee, "0");
  assert.equal(r.quote.user, G_USER);
  assert.equal(r.contract, STELLAR_CONTRACT);

  const bytes = encodeQuoteBytes(deserializeQuote(r.quote), "stellar", STELLAR_CONTRACT);
  const sig = new Uint8Array(Buffer.from(r.signature.slice(2), "hex"));
  assert.equal(sig.length, 64);
  assert.ok(verifyEd25519Quote(bytes, sig, ed25519PublicKeyFromSeed(TEST_ONLY_ED25519_SEED)));
});

test("Solana source: ed25519 over the solana-family encoding", async () => {
  const r = ok(
    await buildQuote(
      { ...baseReq, source: "solana", user: SOL_USER },
      deps(),
    ),
  );
  assert.equal(r.quote.amount, "100000000"); // 6-dp, no scaling
  const bytes = encodeQuoteBytes(deserializeQuote(r.quote), "solana", SOLANA_PROGRAM);
  const sig = new Uint8Array(Buffer.from(r.signature.slice(2), "hex"));
  assert.ok(verifyEd25519Quote(bytes, sig, ed25519PublicKeyFromSeed(TEST_ONLY_ED25519_SEED)));
});

// ------------------------------------------------------------- native mode

test("native mode: insufficient source native balance -> insufficient_native", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, networkFeeMode: "native" },
      deps({
        ...noSign,
        nativeBalance: async () => BigInt(7_000 + 499),
        ownGasAllowance: async () => BigInt(500),
      }),
    ),
  );
  assert.equal(r.code, "insufficient_native");
  assert.match(r.error, /Not enough ETH/);
  assert.equal(httpStatusFor(r.code), 400);
});

test("native mode: enough balance -> nativeFee signed, networkFee 0, not scaled on Stellar", async () => {
  const seen: unknown[] = [];
  const r = ok(
    await buildQuote(
      { ...baseReq, networkFeeMode: "native" },
      deps({
        nativeBalance: async (chain, user) => {
          seen.push([chain, user]);
          return BigInt(7_500);
        },
        ownGasAllowance: async () => BigInt(500),
      }),
    ),
  );
  assert.deepEqual(seen, [["base", EVM_USER]]);
  assert.equal(r.quote.nativeFee, "7000");
  assert.equal(r.quote.networkFee, "0");
  assert.equal(r.breakdown.receiveAtomic, "99700000");

  const s = ok(
    await buildQuote(
      {
        source: "stellar",
        dest: "base",
        amount: "100",
        speed: "standard",
        user: G_USER,
        recipient: EVM_RECIPIENT,
        networkFeeMode: "native",
      },
      deps({ nativeBalance: async () => BigInt(10_000_000), ownGasAllowance: async () => BigInt(0) }),
    ),
  );
  assert.equal(s.quote.nativeFee, "7000"); // stroops, as estimated
  assert.equal(s.quote.amount, "1000000000");
});

test("native mode: a balance read failure -> unavailable", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, networkFeeMode: "native" },
      deps({
        ...noSign,
        nativeBalance: async () => {
          throw new Error("rpc");
        },
      }),
    ),
  );
  assert.equal(r.code, "unavailable");
});

// ------------------------------------------------------------- fix round 1

test("Fast with no Iris Fast entry (null) -> 409 fast_unavailable, never signed", async () => {
  const r = err(
    await buildQuote({ ...baseReq, speed: "fast" }, deps({ ...noSign, getFastFeeBps: async () => null })),
  );
  assert.equal(r.code, "fast_unavailable");
  assert.equal(httpStatusFor(r.code), 409);
});

test("Fast with a malformed Iris body (via the strict parser) -> fast_unavailable", async () => {
  const { parseFastMinimumFeeBps } = await import("../cctp/iris-client");
  for (const body of [[{ finalityThreshold: 1000, minimumFee: "x" }], [{ finalityThreshold: 2000, minimumFee: 1 }], {}]) {
    const r = err(
      await buildQuote(
        { ...baseReq, speed: "fast" },
        deps({ ...noSign, getFastFeeBps: async () => parseFastMinimumFeeBps(body) }),
      ),
    );
    assert.equal(r.code, "fast_unavailable", JSON.stringify(body));
  }
});

test("Fast with an explicit 0 Iris fee -> signed, maxFee 0, minFinality 1000", async () => {
  const r = ok(await buildQuote({ ...baseReq, speed: "fast" }, deps({ getFastFeeBps: async () => 0 })));
  assert.equal(r.quote.maxFee, "0");
  assert.equal(r.quote.minFinality, 1000);
  assert.equal(r.quote.settuFee, "600000");
});

test("Standard never asks Iris, so a missing Fast entry doesn't matter", async () => {
  const r = ok(
    await buildQuote(
      baseReq,
      deps({ getFastFeeBps: async () => assert.fail("Standard must not read the Fast fee") }),
    ),
  );
  assert.equal(r.quote.minFinality, 2000);
});

test("amount cap: >20 integer digits or >32 chars -> 400 before any network call", async () => {
  const offline: Partial<BuildQuoteDeps> = {
    ...noSign,
    getFeeBps: async () => assert.fail("no reads"),
    checkDestinationLive: async () => assert.fail("no reads"),
    estimateNetworkFee: async () => assert.fail("no reads"),
    getFastFeeBps: async () => assert.fail("no reads"),
  };
  for (const amount of ["1".repeat(21), "1." + "0".repeat(31), "9".repeat(33)]) {
    const r = err(await buildQuote({ ...baseReq, amount }, deps(offline)));
    assert.equal(r.code, "invalid_amount", amount);
    assert.equal(httpStatusFor(r.code), 400);
  }
});

test("u64-overflow amount on a Stellar or Solana source -> 400, not 503", async () => {
  const offline: Partial<BuildQuoteDeps> = {
    ...noSign,
    checkDestinationLive: async () => assert.fail("no reads"),
    estimateNetworkFee: async () => assert.fail("no reads"),
  };
  // u64 max ~1.8e19: 7-dp Stellar overflows at ~1.8e12 USDC, 6-dp Solana at ~1.8e13.
  const cases: QuoteRequest[] = [
    { ...baseReq, source: "stellar", user: G_USER, amount: "2000000000000" },
    { ...baseReq, source: "solana", user: SOL_USER, amount: "20000000000000" },
  ];
  for (const req of cases) {
    const r = err(await buildQuote(req, deps(offline)));
    assert.equal(r.code, "invalid_amount", req.source);
    assert.equal(httpStatusFor(r.code), 400);
  }
});

test("Solana destination: an ATA from the live check that doesn't re-derive -> internal 500", async () => {
  const r = err(
    await buildQuote(
      { ...baseReq, dest: "solana", recipient: SOL_RECIPIENT },
      deps({
        ...noSign,
        checkDestinationLive: async () => ({
          ok: true,
          solanaAta: "CLTcs7gP4PLPaU5uLQ7oCsgAhXg9aQHXfM5rXkyXWZqi", // devnet-mint ATA, wrong here
          needsSolanaAta: false,
        }),
      }),
    ),
  );
  assert.equal(r.code, "internal");
  assert.equal(httpStatusFor(r.code), 500);
  assert.doesNotMatch(r.error, /CLTcs|42Jre|ATA/);
});

test("a Redis failure reading the fee -> unavailable with the no-price copy, not fee_config", async () => {
  const r = err(
    await buildQuote(
      baseReq,
      deps({
        ...noSign,
        getFeeBps: async () => {
          throw new Error("Upstash unreachable");
        },
      }),
    ),
  );
  assert.equal(r.code, "unavailable");
  assert.equal(r.error, QUOTE_UNAVAILABLE_MESSAGE);
  assert.equal(httpStatusFor(r.code), 503);
});

test("signed quote is recorded by nonce with recipient, speed, maxFee, receiveMin", async () => {
  const saved: { nonce: string; rec: any }[] = [];
  const r = ok(await buildQuote({ ...baseReq, speed: "fast" }, deps({
    saveQuoteRecord: async (nonce, rec) => { saved.push({ nonce, rec }); },
  })));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].nonce, r.quote.nonce);
  assert.equal(saved[0].rec.recipient, EVM_RECIPIENT);
  assert.equal(saved[0].rec.speed, "fast");
  assert.equal(saved[0].rec.source, "base");
  assert.equal(saved[0].rec.dest, "arbitrum");
  assert.equal(saved[0].rec.receiveMinAtomic, r.breakdown.receiveAtomic);
  assert.equal(saved[0].rec.maxFeeAtomic, r.breakdown.fastFeeMaxAtomic);
});

test("a failing quote-record write does not fail the quote", async () => {
  const r = await buildQuote(baseReq, deps({ saveQuoteRecord: async () => { throw new Error("redis down"); } }));
  assert.ok(!("error" in r));
});
