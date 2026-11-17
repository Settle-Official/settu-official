# SettuBridge (EVM)

One Solidity contract, deployed once per EVM chain (Ethereum, Base, Arbitrum,
Optimism, Avalanche, Polygon). In a single user call it verifies a Settu-signed
EIP-712 quote, sends the quoted fees to Settu's fee wallet (USDC, plus an
optional native-token fee equal to `msg.value`), and burns the rest of the USDC
through Circle CCTP V2 `TokenMessengerV2.depositForBurn` (or
`depositForBurnWithHook` when the quote carries `hookData`). See spec section 5
in `docs/superpowers/specs/2026-11-16-user-bridge-design.md`.

The quote schema must match `src/lib/bridge/quote.ts` byte for byte. The test
suite checks the contract against the golden vector in
`contracts/test-vectors/quotes.json` (the `evm` case).

## Setup

Needs Foundry (`forge` 1.3+) and the repo's npm dev dependencies.

```sh
# from the repo root: OpenZeppelin 5.6.1 comes from npm (pinned devDependency)
npm install

# forge-std goes into contracts/evm/lib (git-ignored)
cd contracts/evm
forge install --no-git foundry-rs/forge-std
```

`foundry.toml` remaps `@openzeppelin/` to `../../node_modules/@openzeppelin/`
and pins solc 0.8.28 with `evm_version = "cancun"` (OpenZeppelin 5.6 uses
`MCOPY`; Cancun is live on all six target chains).

## Build and test

```sh
cd contracts/evm
forge build
forge test -vv
forge coverage --report summary
```

## Deploy

`script/Deploy.s.sol` reads every constructor argument from the environment.
The deployer key is never read from env by the script; pass it with forge's
wallet flags (`--account <keystore>`, `--ledger`, or `--private-key`).

| Env var | Meaning |
| --- | --- |
| `SETTU_BRIDGE_USDC` | Native USDC on this chain |
| `SETTU_BRIDGE_TOKEN_MESSENGER` | Circle `TokenMessengerV2` on this chain |
| `SETTU_BRIDGE_LOCAL_DOMAIN` | This chain's CCTP domain (e.g. Ethereum 0, Avalanche 1, Optimism 2, Arbitrum 3, Base 6, Polygon 7) |
| `SETTU_BRIDGE_SIGNER` | Address of the quote-signing key (`BRIDGE_QUOTE_SIGNER_EVM_KEY` on the server) |
| `SETTU_BRIDGE_FEE_WALLET` | Receives USDC and native fees |
| `SETTU_BRIDGE_OWNER` | Owner (Ownable2Step): the business owner's wallet, not a server key |
| `SETTU_BRIDGE_MAX_NETWORK_FEE` | Max `networkFee`, USDC atomic (6 decimals) |
| `SETTU_BRIDGE_MAX_NATIVE_FEE` | Max `nativeFee`, native-token wei |

Verify the USDC and TokenMessengerV2 addresses against Circle's docs (raw
source, not a summary) before deploying.

```sh
cd contracts/evm
# dry run (simulation only)
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --account deployer
# real deploy
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --account deployer --broadcast --verify
```

`maxFeeBps` starts at 100 (1%). After deploying, the owner can change it and
the other limits with `setMaxFeeBps`, `setMaxNetworkFee`, `setMaxNativeFee`,
`setSigner` and `setFeeWallet`, and can `pause` / `unpause`. Ownership moves
in two steps (`transferOwnership`, then `acceptOwnership` from the new owner);
`renounceOwnership` is disabled.
