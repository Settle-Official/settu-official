/**
 * Which network a Stellar wallet signs for. Defaults to mainnet: the live
 * offramp calls signTransaction with no passphrase and must stay unchanged.
 * The admin console passes the passphrase its owner tx was built for
 * (testnet on CCTP_NETWORK=testnet).
 */

export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export interface SignOptions {
  networkPassphrase: string;
  /** CAIP-2 chain for the WalletConnect stellar_signXDR request. */
  wcChainId: "stellar:pubnet" | "stellar:testnet";
}

export function resolveSignOptions(networkPassphrase: string = MAINNET_PASSPHRASE): SignOptions {
  return {
    networkPassphrase,
    wcChainId: networkPassphrase === TESTNET_PASSPHRASE ? "stellar:testnet" : "stellar:pubnet",
  };
}
