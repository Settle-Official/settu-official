import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { advanceLocked, type AdvanceDeps } from "./advance";
import { mergeCctpTransfer, type BridgeMeta, type CctpTransferRecord } from "./cctp-store";
import { CctpBaseGasError, submitEvmMint, type EvmClients } from "./base-cctp";
import { buildV2Message } from "./message.test-helper";
import { deriveUsdcAta } from "../bridge/address-live";
import { BRIDGE_CHAINS } from "../bridge/chains";
import type { GasReading } from "../notify/gas-alert";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ATA = deriveUsdcAta(WALLET, BRIDGE_CHAINS.solana.usdc);
const ATA_HEX = `0x${Buffer.from(new PublicKey(ATA).toBytes()).toString("hex")}`;

function meta(over: Partial<BridgeMeta> = {}): BridgeMeta {
  return {
    source: "base",
    dest: "arbitrum",
    user: "0x" + "1".repeat(40),
    recipient: "0x" + "2".repeat(40),
    speed: "fast",
    quoteNonce: "0x01",
    sendAtomic: "1000000",
    settuFeeAtomic: "1000",
    networkFeeAtomic: "2000",
    fastFeeMaxAtomic: "100",
    receiveMinAtomic: "996900",
    ...over,
  };
}

function record(over: Partial<CctpTransferRecord> = {}): CctpTransferRecord {
  return {
    id: "0xabc",
    direction: "bridge",
    bridge: meta(),
    sourceDomain: 6,
    destDomain: 3,
    burnTxHash: "0xabc",
    mintRecipient: "0x" + "0".repeat(24) + "2".repeat(40),
    status: "attested",
    attestationMessage: "0x01",
    attestationSignature: "0x02",
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

interface Harness {
  deps: AdvanceDeps;
  calls: { fn: string; args: unknown[] }[];
  notifies: { message: string; level: string }[];
  current(): CctpTransferRecord;
}

/** In-memory store + recording fakes; nothing touches the network. */
function harness(initial: CctpTransferRecord, over: Partial<AdvanceDeps> = {}): Harness {
  let rec = initial;
  const calls: Harness["calls"] = [];
  const notifies: Harness["notifies"] = [];
  const rec_ = (fn: string, value: unknown) => async (...args: unknown[]) => {
    calls.push({ fn, args });
    return value;
  };
  const deps: AdvanceDeps = {
    update: async (_id, patch) => {
      rec = mergeCctpTransfer(rec, patch);
      return rec;
    },
    fetchAttestation: rec_("fetchAttestation", null) as AdvanceDeps["fetchAttestation"],
    reattest: rec_("reattest", undefined) as AdvanceDeps["reattest"],
    submitBaseMint: rec_("submitBaseMint", "0xbase") as AdvanceDeps["submitBaseMint"],
    submitMintAndForward: rec_("submitMintAndForward", "stellarhash") as AdvanceDeps["submitMintAndForward"],
    submitEvmMint: rec_("submitEvmMint", "0xevm") as AdvanceDeps["submitEvmMint"],
    submitStellarBridgeMint: rec_("submitStellarBridgeMint", "stellarbridge") as AdvanceDeps["submitStellarBridgeMint"],
    submitSolanaMint: rec_("submitSolanaMint", "solsig") as AdvanceDeps["submitSolanaMint"],
    readReceivedAtomic: rec_("readReceivedAtomic", BigInt(996_950)) as AdvanceDeps["readReceivedAtomic"],
    notify: async (message, level) => {
      notifies.push({ message, level: level ?? "info" });
      return true;
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, calls, notifies, current: () => rec };
}

const called = (h: Harness, fn: string) => h.calls.filter((c) => c.fn === fn);

test("a bridge to Arbitrum mints with submitEvmMint('arbitrum', …)", async () => {
  const h = harness(record());
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "minting");
  const evm = called(h, "submitEvmMint");
  assert.equal(evm.length, 1);
  assert.equal(evm[0].args[0], "arbitrum");
  assert.deepEqual(evm[0].args[1], { messageHex: "0x01", attestationHex: "0x02" });
  assert.equal(called(h, "submitBaseMint").length, 0);
  assert.equal(called(h, "submitMintAndForward").length, 0);
  assert.equal(h.current().mintTxHash, "0xevm");
});

test("a bridge to Base uses the bridge EVM path, not the offramp's submitBaseMint", async () => {
  const h = harness(record({ destDomain: 6, sourceDomain: 3, bridge: meta({ source: "arbitrum", dest: "base" }) }));
  await advanceLocked("0xabc", h.current(), h.deps);
  assert.equal(called(h, "submitEvmMint")[0].args[0], "base");
  assert.equal(called(h, "submitBaseMint").length, 0);
});

test("a bridge to Stellar mints via the bridge mint-and-forward, not the onramp's", async () => {
  const h = harness(record({ destDomain: 27, bridge: meta({ dest: "stellar", recipient: "G" + "A".repeat(55) }) }));
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "minting");
  assert.equal(called(h, "submitStellarBridgeMint").length, 1);
  assert.deepEqual(called(h, "submitStellarBridgeMint")[0].args[0], {
    messageHex: "0x01",
    attestationHex: "0x02",
  });
  assert.equal(called(h, "submitMintAndForward").length, 0);
});

test("a bridge to Solana calls submitSolanaMint with the ATA, creating it for a known wallet", async () => {
  const h = harness(
    record({ destDomain: 5, mintRecipient: ATA_HEX, bridge: meta({ dest: "solana", recipient: WALLET }) }),
  );
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "minting");
  const sol = called(h, "submitSolanaMint");
  assert.equal(sol.length, 1);
  assert.deepEqual(sol[0].args[0], {
    messageHex: "0x01",
    attestationHex: "0x02",
    recipientAta: ATA,
    createAta: true,
    recipientOwner: WALLET,
  });
});

test("a Solana bridge whose recipient is only known as a token account never creates an ATA", async () => {
  const h = harness(
    record({
      destDomain: 5,
      mintRecipient: ATA_HEX,
      bridge: meta({ dest: "solana", recipient: ATA, recipientIsTokenAccount: true }),
    }),
  );
  await advanceLocked("0xabc", h.current(), h.deps);
  assert.deepEqual(called(h, "submitSolanaMint")[0].args[0], {
    messageHex: "0x01",
    attestationHex: "0x02",
    recipientAta: ATA,
    createAta: false,
  });
});

test("a null mint (already minted on-chain) completes the bridge", async () => {
  const h = harness(record(), { submitEvmMint: async () => null });
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "completed");
  assert.equal(h.current().status, "completed");
});

test("minting → completed stores the actual received amount from the destination tx", async () => {
  const h = harness(record({ status: "minting", mintTxHash: "0xevm" }));
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "completed");
  const read = called(h, "readReceivedAtomic");
  assert.equal(read.length, 1);
  assert.equal(read[0].args[0], "arbitrum");
  assert.equal(read[0].args[1], "0xevm");
  assert.deepEqual(read[0].args[2], { mintRecipient: record().mintRecipient });
  assert.equal(h.current().bridge?.receivedAtomic, "996950");
  assert.equal(h.current().bridge?.dest, "arbitrum"); // rest of meta kept
});

test("review focus 5: 25 consecutive gas-floor errors leave the bridge attested, attempts unchanged, alert reported", async () => {
  const reports: GasReading[] = [];
  let sends = 0;
  const lowGasClients = {
    account: { address: "0x" + "9".repeat(40) },
    publicClient: {
      readContract: async () => BigInt(0), // not yet minted
      getBalance: async () => BigInt(1), // 1 wei: under any floor
      getTransactionCount: async () => 0,
      estimateFeesPerGas: async () => ({ maxFeePerGas: BigInt(1), maxPriorityFeePerGas: BigInt(1) }),
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
    walletClient: {
      sendTransaction: async () => {
        sends++;
        return "0xsent";
      },
    },
  } as unknown as EvmClients;
  const message = buildV2Message({
    sourceDomain: 6,
    destDomain: 3,
    finalityThresholdExecuted: 1000,
    mintRecipient: "2".repeat(40),
    amount: BigInt(996_900),
  });
  const h = harness(record({ attempts: 3, attestationMessage: message }), {
    submitEvmMint: (chain, p) =>
      submitEvmMint(chain, p, {
        signer: "bridge",
        deps: { clients: () => lowGasClients, reportGasBalance: async (r) => void reports.push(r) },
      }),
  });
  for (let i = 0; i < 25; i++) {
    assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "attested");
  }
  const r = h.current();
  assert.equal(r.status, "attested");
  assert.equal(r.attempts, 3);
  assert.match(r.lastError ?? "", /below floor/);
  assert.equal(sends, 0);
  assert.equal(reports.length, 25);
  assert.match(reports[0].wallet, /Arbitrum/);
  assert.ok(reports[0].balance < reports[0].floor);
  assert.equal(h.notifies.length, 0); // no "failed" alert
});

test("a gas-floor error class thrown by the mint is recognised (Base error class too)", async () => {
  const h = harness(record(), {
    submitEvmMint: async () => {
      throw new CctpBaseGasError("hot wallet ETH balance 1 below floor 2; refusing to submit");
    },
  });
  for (let i = 0; i < 21; i++) await advanceLocked("0xabc", h.current(), h.deps);
  assert.equal(h.current().status, "attested");
  assert.equal(h.current().attempts, 0);
});

test("offramp transfers still mint with submitBaseMint", async () => {
  const h = harness(record({ direction: "offramp", bridge: undefined, sourceDomain: 27, destDomain: 6 }));
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "minting");
  assert.equal(called(h, "submitBaseMint").length, 1);
  assert.deepEqual(called(h, "submitBaseMint")[0].args[0], { messageHex: "0x01", attestationHex: "0x02" });
  assert.equal(called(h, "submitEvmMint").length, 0);
  assert.equal(h.current().mintTxHash, "0xbase");
});

test("onramp transfers still mint with submitMintAndForward (onramp key)", async () => {
  const h = harness(record({ direction: "onramp", bridge: undefined, sourceDomain: 6, destDomain: 27 }));
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "minting");
  assert.equal(called(h, "submitMintAndForward").length, 1);
  assert.equal(called(h, "submitStellarBridgeMint").length, 0);
});

test("offramp/onramp: minting completes without reading a received amount; gas errors still count", async () => {
  const h = harness(record({ direction: "offramp", bridge: undefined, status: "minting", mintTxHash: "0x1" }));
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "completed");
  assert.equal(called(h, "readReceivedAtomic").length, 0);

  const g = harness(record({ direction: "offramp", bridge: undefined, attempts: 19 }), {
    submitBaseMint: async () => {
      throw new CctpBaseGasError("below floor");
    },
  });
  assert.equal(await advanceLocked("0xabc", g.current(), g.deps), "failed");
  assert.equal(g.current().attempts, 20);
  assert.equal(g.notifies.length, 0); // offramp alerting unchanged
});

test("a Fast quote attested at finality 2000 is marked fellBackToStandard, with attestedAt", async () => {
  const message = buildV2Message({
    sourceDomain: 6,
    destDomain: 3,
    finalityThresholdExecuted: 2000,
    mintRecipient: "2".repeat(40),
    amount: BigInt(996_900),
  });
  const h = harness(record({ status: "attesting", attestationMessage: undefined, attestationSignature: undefined }), {
    fetchAttestation: async () => ({ message, attestation: "0x99", status: "complete" }),
  });
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "attested");
  const r = h.current();
  assert.equal(r.attestationMessage, message);
  assert.equal(r.bridge?.attestedAt, 1_700_000_000_000);
  assert.equal(r.bridge?.fellBackToStandard, true);
  assert.equal(r.bridge?.dest, "arbitrum");
});

test("a Fast quote attested at 1000 (or a Standard quote) is not a fallback", async () => {
  for (const [speed, fte] of [["fast", 1000], ["standard", 2000]] as const) {
    const message = buildV2Message({
      sourceDomain: 6,
      destDomain: 3,
      finalityThresholdExecuted: fte,
      mintRecipient: "2".repeat(40),
      amount: BigInt(1),
    });
    const h = harness(record({ status: "burned", bridge: meta({ speed }) }), {
      fetchAttestation: async () => ({ message, attestation: "0x99", status: "complete" }),
    });
    await advanceLocked("0xabc", h.current(), h.deps);
    assert.equal(h.current().bridge?.fellBackToStandard, undefined);
    assert.equal(h.current().bridge?.attestedAt, 1_700_000_000_000);
  }
});

test("a bridge transitioning to failed sends exactly one critical notify with id, route and error", async () => {
  const h = harness(record({ attempts: 18 }), {
    submitEvmMint: async () => {
      throw new Error("execution reverted: <bad>");
    },
  });
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "attested"); // 19
  assert.equal(h.notifies.length, 0);
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "failed"); // 20
  assert.equal(await advanceLocked("0xabc", h.current(), h.deps), "failed"); // frozen
  assert.equal(h.notifies.length, 1);
  const n = h.notifies[0];
  assert.equal(n.level, "critical");
  assert.match(n.message, /0xabc/);
  assert.match(n.message, /base/i);
  assert.match(n.message, /arbitrum/i);
  assert.match(n.message, /execution reverted: &lt;bad&gt;/);
});
