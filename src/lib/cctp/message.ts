/**
 * Decoder for an attested CCTP V2 burn message (MessageV2 header +
 * BurnMessageV2 body). Offsets per Circle's MessageV2/BurnMessageV2 layout,
 * the same ones `cctpMessageNonce` (base-cctp.ts) and Circle's
 * `decodeEventNonceFromMessageV2` (solana-cctp-contracts examples/v2) use:
 *
 *   header: version 0..4, sourceDomain 4..8, destinationDomain 8..12,
 *           nonce 12..44, sender 44..76, recipient 76..108,
 *           destinationCaller 108..140, minFinalityThreshold 140..144,
 *           finalityThresholdExecuted 144..148, body 148..
 *   body:   version +0..4, burnToken +4..36, mintRecipient +36..68,
 *           amount +68..100, messageSender +100..132, maxFee +132..164,
 *           feeExecuted +164..196, expirationBlock +196..228, hookData +228..
 */

export interface CctpMessage {
  sourceDomain: number;
  destDomain: number;
  nonce: Buffer;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  burnToken: Buffer;
  mintRecipient: Buffer;
  amount: bigint;
  maxFee: bigint;
  feeExecuted: bigint;
}

const HEADER = 148;
const BODY_MIN = 228;

export function parseCctpMessage(messageHex: string): CctpMessage {
  const b = Buffer.from(messageHex.replace(/^0x/i, ""), "hex");
  if (b.length < HEADER + BODY_MIN) throw new Error("CCTP message too short for a burn body");
  const u256 = (at: number) => BigInt(`0x${b.subarray(at, at + 32).toString("hex")}`);
  return {
    sourceDomain: b.readUInt32BE(4),
    destDomain: b.readUInt32BE(8),
    nonce: Buffer.from(b.subarray(12, 44)),
    minFinalityThreshold: b.readUInt32BE(140),
    finalityThresholdExecuted: b.readUInt32BE(144),
    burnToken: Buffer.from(b.subarray(HEADER + 4, HEADER + 36)),
    mintRecipient: Buffer.from(b.subarray(HEADER + 36, HEADER + 68)),
    amount: u256(HEADER + 68),
    maxFee: u256(HEADER + 132),
    feeExecuted: u256(HEADER + 164),
  };
}
