import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { getAddress } from "viem";
import {
  BRIDGE_FORBIDDEN_ADDRESSES,
  validateDestinationAddress,
} from "./address";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { CCTP_CONFIG } from "../cctp/constants";
import { EVM_CCTP_TOKEN_MESSENGER_V2 } from "../cctp/evm-chains";
import { SOLANA_CONFIG } from "../solana/config";

const EVM_ADDR = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 sample
const SOL_ADDR = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const G_ADDR = Keypair.random().publicKey();
const EVM_CHAINS: BridgeChainKey[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "avalanche",
  "polygon",
];
const ALL_CHAINS = Object.keys(BRIDGE_CHAINS) as BridgeChainKey[];

function fail(chain: BridgeChainKey, input: string) {
  const r = validateDestinationAddress(chain, input);
  assert.equal(r.ok, false, `expected ${input} to fail on ${chain}`);
  return r as Extract<typeof r, { ok: false }>;
}

test("empty and whitespace-only input", () => {
  assert.equal(fail("base", "").code, "empty");
  assert.equal(fail("solana", "   ").code, "empty");
});

test("evm: checksummed, lowercase and uppercase-hex addresses are ok", () => {
  for (const chain of EVM_CHAINS) {
    assert.deepEqual(validateDestinationAddress(chain, EVM_ADDR), {
      ok: true,
      address: EVM_ADDR,
    });
  }
  assert.deepEqual(validateDestinationAddress("base", EVM_ADDR.toLowerCase()), {
    ok: true,
    address: getAddress(EVM_ADDR.toLowerCase()),
  });
});

test("evm: one wrong-case letter is bad_checksum", () => {
  const i = EVM_ADDR.split("").findIndex((c, n) => n > 1 && /[a-f]/i.test(c));
  const ch = EVM_ADDR[i];
  const flipped =
    EVM_ADDR.slice(0, i) +
    (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) +
    EVM_ADDR.slice(i + 1);
  assert.equal(fail("base", flipped).code, "bad_checksum");
});

test("evm: wrong length is bad_format", () => {
  assert.equal(fail("base", EVM_ADDR.slice(0, -1)).code, "bad_format");
  assert.equal(fail("base", EVM_ADDR + "0").code, "bad_format");
  assert.equal(fail("base", "0xZZ" + EVM_ADDR.slice(4)).code, "bad_format");
});

test("wrong family: exact Stellar-on-Base message", () => {
  const r = fail("base", G_ADDR);
  assert.equal(r.code, "wrong_family");
  assert.equal(
    r.message,
    "That's a Stellar address. Base needs an address starting with 0x.",
  );
});

test("wrong family: 0x address on Solana and Stellar", () => {
  const r = fail("solana", EVM_ADDR);
  assert.equal(r.code, "wrong_family");
  assert.equal(
    r.message,
    "That's an Ethereum-style address. Solana needs a Solana wallet address.",
  );
  assert.equal(fail("stellar", EVM_ADDR).code, "wrong_family");
});

test("wrong family: Solana address on EVM and Stellar, Stellar on Solana", () => {
  assert.equal(fail("base", SOL_ADDR).code, "wrong_family");
  assert.equal(fail("stellar", SOL_ADDR).code, "wrong_family");
  assert.equal(fail("solana", G_ADDR).code, "wrong_family");
});

test("solana: valid 32-byte key ok, 31 bytes is bad_format", () => {
  assert.deepEqual(validateDestinationAddress("solana", SOL_ADDR), {
    ok: true,
    address: SOL_ADDR,
  });
  assert.equal(fail("solana", SOL_ADDR.slice(0, -1)).code, "bad_format");
  assert.equal(fail("solana", "abc0OIl").code, "bad_format");
});

test("stellar: valid G ok", () => {
  assert.deepEqual(validateDestinationAddress("stellar", G_ADDR), {
    ok: true,
    address: G_ADDR,
  });
});

test("stellar: bad checksum", () => {
  const last = G_ADDR.slice(-1) === "A" ? "B" : "A";
  assert.equal(fail("stellar", G_ADDR.slice(0, -1) + last).code, "bad_checksum");
});

test("stellar: S key, M muxed, C contract", () => {
  const secret = Keypair.random().secret();
  const r = fail("stellar", secret);
  assert.equal(r.code, "secret_key");
  assert.equal(r.message, "That's a secret key — never paste it anywhere");
  const muxed = StrKey.encodeMed25519PublicKey(
    Buffer.concat([StrKey.decodeEd25519PublicKey(G_ADDR), Buffer.alloc(8)]),
  );
  assert.equal(fail("stellar", muxed).code, "muxed");
  const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
  assert.equal(fail("stellar", contract).code, "contract");
});

test("secret keys are caught on every destination", () => {
  const secret = Keypair.random().secret();
  for (const chain of ALL_CHAINS) {
    assert.equal(fail(chain, secret).code, "secret_key");
  }
});

test("forbidden: zero address, USDC and CCTP contracts on every EVM chain", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  for (const chain of EVM_CHAINS) {
    assert.equal(fail(chain, zero).code, "forbidden");
    assert.equal(fail(chain, BRIDGE_CHAINS[chain].usdc).code, "forbidden");
    assert.equal(
      fail(chain, BRIDGE_CHAINS[chain].usdc.toLowerCase()).code,
      "forbidden",
    );
    assert.equal(fail(chain, EVM_CCTP_TOKEN_MESSENGER_V2).code, "forbidden");
    assert.equal(fail(chain, CCTP_CONFIG.baseMessageTransmitterV2).code, "forbidden");
  }
});

test("forbidden: Solana USDC mint and CCTP programs", () => {
  assert.equal(fail("solana", SOLANA_CONFIG.usdcMint).code, "forbidden");
  assert.equal(fail("solana", SOLANA_CONFIG.messageTransmitterV2).code, "forbidden");
  assert.equal(fail("solana", SOLANA_CONFIG.tokenMessengerMinterV2).code, "forbidden");
});

test("forbidden: Stellar USDC and CCTP contracts", () => {
  for (const c of [
    BRIDGE_CHAINS.stellar.usdc,
    CCTP_CONFIG.stellarTokenMessengerMinter,
    CCTP_CONFIG.stellarMessageTransmitter,
    CCTP_CONFIG.stellarCctpForwarder,
  ]) {
    assert.equal(fail("stellar", c).code, "forbidden");
  }
});

test("forbidden: every entry of BRIDGE_FORBIDDEN_ADDRESSES is rejected", () => {
  for (const chain of ALL_CHAINS) {
    for (const a of BRIDGE_FORBIDDEN_ADDRESSES[chain]) {
      assert.equal(fail(chain, a).ok, false);
    }
  }
});

test("whitespace is trimmed", () => {
  assert.deepEqual(validateDestinationAddress("base", `  ${EVM_ADDR}\n`), {
    ok: true,
    address: EVM_ADDR,
  });
  assert.deepEqual(validateDestinationAddress("stellar", ` ${G_ADDR} `), {
    ok: true,
    address: G_ADDR,
  });
  assert.deepEqual(validateDestinationAddress("solana", ` ${SOL_ADDR}\t`), {
    ok: true,
    address: SOL_ADDR,
  });
});
