// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only stand-in for Circle's TokenMessengerV2. Records the arguments
/// of the last burn and pulls `amount` of `burnToken` from the caller, like the
/// real contract does (it transferFroms msg.sender into the local minter).
contract MockTokenMessengerV2 {
    struct Call {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
        bool withHook;
        address caller;
    }

    Call public last;
    uint256 public calls;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        _record(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            "",
            false
        );
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(hookData.length > 0, "Hook data is empty");
        _record(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData,
            true
        );
    }

    function lastHookData() external view returns (bytes memory) {
        return last.hookData;
    }

    function _record(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes memory hookData,
        bool withHook
    ) private {
        require(amount > 0, "Amount must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        require(IERC20(burnToken).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        last = Call(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData,
            withHook,
            msg.sender
        );
        calls++;
    }
}
