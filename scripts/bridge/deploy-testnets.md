# Settu bridge — testnet deployments

Deployed 2026-11-17 on `feat/user-bridge` (plan Task 9). Testnets only;
mainnet waits for the audit (spec §12). Keys are testnet-only and live outside
the repo in `~/.settu-bridge-testnet/keys.env` (0600), which also holds the
`BRIDGE_CONTRACT_<CHAIN>` / `FEE_WALLET_<CHAIN>` values below.

## Addresses

| Chain | Contract | Deploy tx |
|---|---|---|
| Base Sepolia (84532, domain 6) | `0x341EBE07baDC61621D8Fa4298abcd43c7B4F5FB0` | [0xf24e7c7c…da1c5](https://sepolia.basescan.org/tx/0xf24e7c7c9151eb37aeee6c1ee01ef5aac8b14ea82426e8a537cd9e3ff17da1c5) |
| Arbitrum Sepolia (421614, domain 3) | `0x341EBE07baDC61621D8Fa4298abcd43c7B4F5FB0` | [0x4183e9ed…b336c](https://sepolia.arbiscan.io/tx/0x4183e9edf647282bf0926ded836a88dfe2f989fed2eb94401fec196ca04b336c) |
| Stellar testnet (domain 27) | `CDN4JIXDFJXUYIPQB22NLQ3VGD43IYSLEUEI727BHWJVPLYQ5QD3V4CM` | [54576fb2…9ca3](https://stellar.expert/explorer/testnet/tx/54576fb21e8ca1abc7c60306a205659b441b7a7c2b4ab8612374f789c4789ca3) |
| Solana devnet (domain 5) | program `3CGxb2E9ASpizQtoL8wykokiZ8BH19MXMWmgy17KQmD1`, config PDA `ccC16125PfsTLb9DQZb2a8S5b7HCVN3gj6rWGDkddCy` | deploy [4yzPt9k6…NEw38](https://explorer.solana.com/tx/4yzPt9k6ciFxV7umK75Z2f1us6SC2yLefBQzr7jbBsfwtuaa5RxXe4VTjdPqZK1Wyi8LZETKB1MDzB4cwaQcQqXK?cluster=devnet), initialize [3xgY5DMz…w38](https://explorer.solana.com/tx/3xgY5DMzsEKQYS3EA7ux4CqPtMhPWhxaSCYmdUXxAAJkGwS58zxigx3LVEgkKScwU8Tw16nYnLJmqhjtEmnNEw38?cluster=devnet) |

The two EVM contracts share an address because the same deployer deployed
them at the same nonce.

## Roles

| Role | EVM | Stellar | Solana |
|---|---|---|---|
| Owner (and EVM/Solana upgrade or admin authority) | `0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c` | `GD6YGF422FQSOH2RJMV5WUUFGGGCFKK4TKK6SO3EQES477NBCG2VBDSI` | `7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf` (also the program's upgrade authority) |
| Fee wallet | same as owner | same as owner (USDC trustline added) | same as owner (USDC ATA `BA2XqosyMh7mvgXNzktVkY42vH3g6is49CqJK9pcQjhq`) |
| Quote signer | `0xC0aFbF89C6b834161C7223Df3FaFC209B46FeFaf` (secp256k1) | ed25519 `2b80651a…de20ef` | same ed25519 key, `3vp5t374DGpfngTmPxvCQ6FekQ6WR6PkC5w9vNzPGVyx` |
| Relayer (destination mints) | `0x8c01a0E89BE58373108D771878FEb2e411Cbe7D4` | `GB7FOCT7PAZR33MR66UKIGRXE6EH65KOGJIM6SHKQ3NOENEMAXV3MNQW` | `9mnTVjqtuSxq3t8zNKntXSVeYPMCZAxrKEbHLVJrJZSd` |

## Limits set at deploy

All changeable by the owner from the admin console.

| | maxFeeBps | maxNetworkFee | maxNativeFee |
|---|---|---|---|
| EVM | 100 | 5 USDC (`5000000`) | 0.003 ETH (`3000000000000000` wei) |
| Stellar | 100 | 5 USDC (`50000000`, 7 dp) | 20 XLM (`200000000` stroops) |
| Solana | 100 | 5 USDC (`5000000`) | 0.05 SOL (`50000000` lamports) |

## Circle addresses used

Checked against Circle's raw docs on 2026-11-17
(`developers.circle.com/cctp/references/contract-addresses.md`,
`…/cctp/references/stellar-contracts.md`,
`…/stablecoins/usdc-contract-addresses.md`).

- TokenMessengerV2 (both EVM testnets): `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- USDC: Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Arbitrum Sepolia `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
- Stellar: TokenMessengerMinter `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`, USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (= `USDC:GBBD47…FLA5`), native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- Solana devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

## Commands run

```sh
# EVM (from contracts/evm, env loaded from keys.env)
SETTU_BRIDGE_USDC=<usdc> SETTU_BRIDGE_LOCAL_DOMAIN=<6|3> \
SETTU_BRIDGE_TOKEN_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA \
SETTU_BRIDGE_SIGNER=$BRIDGE_QUOTE_SIGNER_EVM_ADDRESS SETTU_BRIDGE_FEE_WALLET=$FEE_WALLET_EVM \
SETTU_BRIDGE_OWNER=$BRIDGE_EVM_OWNER_ADDRESS SETTU_BRIDGE_MAX_NETWORK_FEE=5000000 \
SETTU_BRIDGE_MAX_NATIVE_FEE=3000000000000000 \
forge script script/Deploy.s.sol --rpc-url <rpc> --private-key "$BRIDGE_EVM_OWNER_PRIVATE_KEY" --broadcast --slow

# Stellar (from contracts/stellar/settu-bridge)
STELLAR_ACCOUNT="$BRIDGE_STELLAR_OWNER_SECRET" stellar contract deploy --network testnet \
  --wasm target/wasm32v1-none/release/settu_bridge.wasm -- \
  --admin $BRIDGE_STELLAR_OWNER_ADDRESS --usdc CBIELTK6… --token_messenger CDNG7HXA… \
  --local_domain 27 --signer 2b80651a… --fee_wallet $FEE_WALLET_STELLAR \
  --native_token CDLZFC3S… --max_network_fee 50000000 --max_native_fee 200000000
STELLAR_ACCOUNT="$BRIDGE_STELLAR_OWNER_SECRET" stellar tx new change-trust \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet

# Solana (from contracts/solana/settu_bridge)
cp ~/.settu-bridge-testnet/solana-program-id.json target/deploy/settu_bridge-keypair.json
solana program deploy target/deploy/settu_bridge.so --program-id target/deploy/settu_bridge-keypair.json \
  --keypair ~/.settu-bridge-testnet/solana-owner.json --upgrade-authority ~/.settu-bridge-testnet/solana-owner.json \
  --url devnet --max-sign-attempts 50 --with-compute-unit-price 50000
# then: create the fee wallet's USDC ATA and call `initialize(signer, fee_wallet, 100, 5000000, 50000000)`
# from the upgrade authority (one-off web3.js script).
```

The first Solana attempt without a priority fee failed mid-write on devnet;
its buffer was closed and the SOL reclaimed before the retry.

## Not done yet

- Ethereum Sepolia, OP Sepolia, Avalanche Fuji, Polygon Amoy (same EVM contract, deploy later).
- Solana address lookup tables (`BRIDGE_SOLANA_ALT` for the source tx, `BRIDGE_SOLANA_LOOKUP_TABLE` for ATA + mint), per the Task 8b and Task 14 reports.
- Measured destination gas units (Task 14, Step 5).
