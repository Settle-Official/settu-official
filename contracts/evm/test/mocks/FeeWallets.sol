// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Fee wallet that refuses native token.
contract RejectingFeeWallet {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Fee wallet that tries to re-enter the bridge when paid native token,
/// and records the revert data of that attempt instead of bubbling it.
contract ReentrantFeeWallet {
    address public target;
    bytes public callData;
    bytes public reentryRevertData;
    bool public attempted;

    function arm(address target_, bytes calldata callData_) external {
        target = target_;
        callData = callData_;
    }

    receive() external payable {
        if (attempted || target == address(0)) return;
        attempted = true;
        (bool ok, bytes memory ret) = target.call(callData);
        require(!ok, "reentry unexpectedly succeeded");
        reentryRevertData = ret;
    }
}
