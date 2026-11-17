/** Test-only: hand-built CCTP V2 burn messages. */

/** Builds a V2 burn message: 148-byte header + BurnMessageV2 body. */
export function buildV2Message(o: {
  sourceDomain: number;
  destDomain: number;
  nonce?: string; // 32-byte hex, no 0x
  finalityThresholdExecuted: number;
  burnToken?: string; // 32-byte hex
  mintRecipient: string; // 32-byte hex
  amount: bigint;
  feeExecuted?: bigint;
}): string {
  const u32 = (n: number) => n.toString(16).padStart(8, "0");
  const b32 = (h = "") => h.replace(/^0x/, "").padStart(64, "0");
  const u256 = (n: bigint) => n.toString(16).padStart(64, "0");
  const header =
    u32(1) +
    u32(o.sourceDomain) +
    u32(o.destDomain) +
    b32(o.nonce ?? "ab".repeat(32)) +
    b32("11") + // sender
    b32("22") + // recipient
    b32() + // destinationCaller
    u32(1000) + // minFinalityThreshold
    u32(o.finalityThresholdExecuted);
  const body =
    u32(1) +
    b32(o.burnToken ?? "33") +
    b32(o.mintRecipient) +
    u256(o.amount) +
    b32("44") + // messageSender
    u256(BigInt(0)) + // maxFee
    u256(o.feeExecuted ?? BigInt(0)) +
    u256(BigInt(0)); // expirationBlock
  return `0x${header}${body}`;
}
