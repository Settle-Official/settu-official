// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SettuBridge} from "../src/SettuBridge.sol";

/// @notice Deploys SettuBridge to one EVM chain. Every constructor argument comes
/// from the environment (see README.md); the deployer key comes from forge's
/// own wallet flags (--account / --ledger / --private-key), never from env here.
contract Deploy is Script {
    function run() external returns (SettuBridge bridge) {
        address usdc = vm.envAddress("SETTU_BRIDGE_USDC");
        address tokenMessenger = vm.envAddress("SETTU_BRIDGE_TOKEN_MESSENGER");
        uint256 localDomainRaw = vm.envUint("SETTU_BRIDGE_LOCAL_DOMAIN");
        require(localDomainRaw <= type(uint32).max, "SETTU_BRIDGE_LOCAL_DOMAIN out of uint32 range");
        uint32 localDomain = uint32(localDomainRaw);
        address signer = vm.envAddress("SETTU_BRIDGE_SIGNER");
        address feeWallet = vm.envAddress("SETTU_BRIDGE_FEE_WALLET");
        address owner = vm.envAddress("SETTU_BRIDGE_OWNER");
        uint256 maxNetworkFee = vm.envUint("SETTU_BRIDGE_MAX_NETWORK_FEE");
        uint256 maxNativeFee = vm.envUint("SETTU_BRIDGE_MAX_NATIVE_FEE");

        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(tokenMessenger.code.length > 0, "TokenMessengerV2 has no code on this chain");

        vm.startBroadcast();
        bridge =
            new SettuBridge(usdc, tokenMessenger, localDomain, signer, feeWallet, owner, maxNetworkFee, maxNativeFee);
        vm.stopBroadcast();

        console2.log("SettuBridge:", address(bridge));
        console2.log("chainId:", block.chainid);
        console2.log("localDomain:", localDomain);
    }
}
