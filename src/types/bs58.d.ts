/**
 * Minimal ambient types for `bs58` v4 (ships none; a new @types dev-dep just
 * for base58 encode/decode isn't worth it). Covers only what this codebase
 * uses.
 */
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array | number[] | Buffer): string;
    decode(string: string): Uint8Array;
  };
  export default bs58;
}
