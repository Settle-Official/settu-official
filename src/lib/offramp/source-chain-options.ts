import {
  EVM_SOURCE_CHAINS,
  isChainEnabled,
  type EvmChainKey,
} from "../cctp/evm-chains";
import { isSolanaEnabled } from "../solana/config";

export type OfframpSourceChainKey = "stellar" | EvmChainKey | "solana";

export interface SourceChainOption {
  code: OfframpSourceChainKey;
  name: string;
}

/**
 * "Stellar" plus every non-Stellar chain turned on via
 * NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED. Shared by FormCard's dropdown
 * and the agent's LLM schema so both only ever offer chains that are
 * actually live — computed fresh each call (env-driven, not memoized) so a
 * test can flip env vars between calls.
 */
export function sourceChainOptions(): SourceChainOption[] {
  return [
    { code: "stellar", name: "Stellar" },
    ...Object.values(EVM_SOURCE_CHAINS)
      .filter((c) => isChainEnabled(c.key))
      .map((c) => ({ code: c.key as OfframpSourceChainKey, name: c.label })),
    ...(isSolanaEnabled()
      ? [{ code: "solana" as OfframpSourceChainKey, name: "Solana" }]
      : []),
  ];
}
