// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {SettuBridge} from "../src/SettuBridge.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {RejectingFeeWallet, ReentrantFeeWallet} from "./mocks/FeeWallets.sol";

contract SettuBridgeTest is Test {
    event Bridged(
        bytes32 indexed nonce,
        address indexed user,
        uint256 amount,
        uint256 settuFee,
        uint256 networkFee,
        uint256 nativeFee,
        uint32 destDomain,
        bytes32 mintRecipient,
        uint32 minFinality
    );

    uint32 constant LOCAL_DOMAIN = 6; // Base
    uint256 constant MAX_NETWORK_FEE = 5e6; // 5 USDC
    uint256 constant MAX_NATIVE_FEE = 0.01 ether;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockUSDC usdc;
    MockTokenMessengerV2 messenger;
    SettuBridge bridge;

    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 userPk = 0xB0B;
    address user;
    address feeWallet = makeAddr("feeWallet");
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");
    address constant RECIPIENT = address(0x5EC1);

    function setUp() public {
        vm.warp(1_750_000_000);
        signer = vm.addr(signerPk);
        user = vm.addr(userPk);
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        bridge = new SettuBridge(
            address(usdc), address(messenger), LOCAL_DOMAIN, signer, feeWallet, owner, MAX_NETWORK_FEE, MAX_NATIVE_FEE
        );
        usdc.mint(user, 1_000e6);
        vm.deal(user, 1 ether);
        vm.prank(user);
        usdc.approve(address(bridge), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _quote() internal view returns (SettuBridge.Quote memory q) {
        q = SettuBridge.Quote({
            version: 1,
            sourceDomain: LOCAL_DOMAIN,
            destDomain: 0,
            user: user,
            amount: 100e6,
            settuFee: 500_000,
            networkFee: 0,
            nativeFee: 0,
            mintRecipient: bytes32(uint256(uint160(RECIPIENT))),
            hookData: "",
            maxFee: 0,
            minFinality: 2000,
            deadline: uint64(block.timestamp + 120),
            nonce: keccak256("nonce-1")
        });
    }

    function _sign(SettuBridge.Quote memory q) internal view returns (bytes memory) {
        return _signWith(signerPk, q);
    }

    function _signWith(uint256 pk, SettuBridge.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, bridge.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _noPermit() internal pure returns (SettuBridge.Permit memory p) {}

    function _bridge(SettuBridge.Quote memory q) internal {
        bytes memory sig = _sign(q); // before the prank: hashQuote is an external call
        vm.prank(user);
        bridge.bridge{value: q.nativeFee}(q, sig, _noPermit());
    }

    function _expectRevertBridge(SettuBridge.Quote memory q, bytes memory sig, uint256 value, bytes memory err)
        internal
    {
        vm.prank(user);
        vm.expectRevert(err);
        bridge.bridge{value: value}(q, sig, _noPermit());
    }

    function _signPermit(uint256 value, uint256 deadline) internal view returns (SettuBridge.Permit memory p) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(bridge), value, usdc.nonces(user), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        p = SettuBridge.Permit({value: value, deadline: deadline, v: v, r: r, s: s, use: true});
    }

    function _assertNoBalanceOrAllowance() internal view {
        assertEq(usdc.balanceOf(address(bridge)), 0, "bridge USDC balance");
        assertEq(address(bridge).balance, 0, "bridge native balance");
        assertEq(usdc.allowance(address(bridge), address(messenger)), 0, "lingering messenger allowance");
    }

    // ------------------------------------------------------------ initial state

    function test_initialState() public view {
        assertEq(address(bridge.usdc()), address(usdc));
        assertEq(address(bridge.tokenMessenger()), address(messenger));
        assertEq(bridge.localDomain(), LOCAL_DOMAIN);
        assertEq(bridge.signer(), signer);
        assertEq(bridge.feeWallet(), feeWallet);
        assertEq(bridge.owner(), owner);
        assertEq(bridge.maxFeeBps(), 100);
        assertEq(bridge.maxNetworkFee(), MAX_NETWORK_FEE);
        assertEq(bridge.maxNativeFee(), MAX_NATIVE_FEE);
        assertFalse(bridge.paused());
    }

    function test_constructor_rejectsZeroAddresses() public {
        address u = address(usdc);
        address m = address(messenger);
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        new SettuBridge(address(0), m, LOCAL_DOMAIN, signer, feeWallet, owner, 1, 1);
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        new SettuBridge(u, address(0), LOCAL_DOMAIN, signer, feeWallet, owner, 1, 1);
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        new SettuBridge(u, m, LOCAL_DOMAIN, address(0), feeWallet, owner, 1, 1);
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        new SettuBridge(u, m, LOCAL_DOMAIN, signer, address(0), owner, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SettuBridge(u, m, LOCAL_DOMAIN, signer, feeWallet, address(0), 1, 1);
    }

    function test_typehashMatchesServer() public view {
        assertEq(
            bridge.QUOTE_TYPEHASH(),
            keccak256(
                "Quote(uint8 version,uint32 sourceDomain,uint32 destDomain,address user,uint256 amount,uint256 settuFee,uint256 networkFee,uint256 nativeFee,bytes32 mintRecipient,bytes hookData,uint256 maxFee,uint32 minFinality,uint64 deadline,bytes32 nonce)"
            )
        );
    }

    // ------------------------------------------------------------ happy paths

    function test_usdcMode_movesExactFeesAndBurnsRest() public {
        SettuBridge.Quote memory q = _quote();
        q.networkFee = 300_000;
        q.maxFee = 10_000;
        uint256 userBefore = usdc.balanceOf(user);

        vm.expectEmit(true, true, false, true, address(bridge));
        emit Bridged(q.nonce, user, q.amount, q.settuFee, q.networkFee, 0, q.destDomain, q.mintRecipient, q.minFinality);
        _bridge(q);

        assertEq(usdc.balanceOf(feeWallet), 800_000, "fee wallet USDC");
        assertEq(usdc.balanceOf(address(messenger)), 99_200_000, "burned");
        assertEq(usdc.balanceOf(user), userBefore - q.amount, "user debited exactly amount");
        assertEq(feeWallet.balance, 0, "no native fee");
        _assertNoBalanceOrAllowance();
        assertTrue(bridge.usedNonces(q.nonce));

        (
            uint256 amount,
            uint32 destinationDomain,
            bytes32 mintRecipient,
            address burnToken,
            bytes32 destinationCaller,
            uint256 maxFee,
            uint32 minFinalityThreshold,
            ,
            bool withHook,
            address caller
        ) = messenger.last();
        assertEq(messenger.calls(), 1);
        assertEq(amount, 99_200_000);
        assertEq(destinationDomain, q.destDomain);
        assertEq(mintRecipient, q.mintRecipient);
        assertEq(burnToken, address(usdc));
        assertEq(destinationCaller, bytes32(0));
        assertEq(maxFee, q.maxFee);
        assertEq(minFinalityThreshold, q.minFinality);
        assertFalse(withHook);
        assertEq(caller, address(bridge));
    }

    function test_nativeMode_forwardsExactNativeFee() public {
        SettuBridge.Quote memory q = _quote();
        q.nativeFee = 0.0015 ether;
        q.minFinality = 1000;
        uint256 userEthBefore = user.balance;

        vm.expectEmit(true, true, false, true, address(bridge));
        emit Bridged(q.nonce, user, q.amount, q.settuFee, 0, q.nativeFee, q.destDomain, q.mintRecipient, 1000);
        _bridge(q);

        assertEq(feeWallet.balance, 0.0015 ether, "native fee reached fee wallet exactly");
        assertEq(user.balance, userEthBefore - 0.0015 ether);
        assertEq(usdc.balanceOf(feeWallet), 500_000, "only settuFee in USDC");
        assertEq(usdc.balanceOf(address(messenger)), 99_500_000);
        _assertNoBalanceOrAllowance();
    }

    function test_zeroFees_burnsWholeAmount() public {
        SettuBridge.Quote memory q = _quote();
        q.settuFee = 0;
        _bridge(q);
        assertEq(usdc.balanceOf(feeWallet), 0);
        assertEq(usdc.balanceOf(address(messenger)), q.amount);
        _assertNoBalanceOrAllowance();
    }

    function test_hookData_usesDepositForBurnWithHook() public {
        SettuBridge.Quote memory q = _quote();
        q.destDomain = 27; // Stellar
        q.hookData = hex"00000000000000000000000000000000000000000000000000000000000000384742";
        _bridge(q);
        (,,,,,,,, bool withHook,) = messenger.last();
        assertTrue(withHook);
        assertEq(messenger.lastHookData(), q.hookData);
        _assertNoBalanceOrAllowance();
    }

    function test_feeExactlyAtCap_passes() public {
        SettuBridge.Quote memory q = _quote();
        q.settuFee = 1e6; // exactly 1% of 100 USDC
        q.networkFee = MAX_NETWORK_FEE;
        q.nativeFee = MAX_NATIVE_FEE;
        _bridge(q);
        assertEq(usdc.balanceOf(feeWallet), 1e6 + MAX_NETWORK_FEE);
        assertEq(feeWallet.balance, MAX_NATIVE_FEE);
        _assertNoBalanceOrAllowance();
    }

    function test_deadlineEqualToNow_passes() public {
        SettuBridge.Quote memory q = _quote();
        q.deadline = uint64(block.timestamp);
        _bridge(q);
        assertTrue(bridge.usedNonces(q.nonce));
    }

    // ------------------------------------------------------------ permit

    function test_permit_pullsWithoutPriorApproval() public {
        vm.prank(user);
        usdc.approve(address(bridge), 0);
        SettuBridge.Quote memory q = _quote();
        SettuBridge.Permit memory p = _signPermit(q.amount, block.timestamp + 600);
        bytes memory sig = _sign(q);

        vm.prank(user);
        bridge.bridge(q, sig, p);

        assertEq(usdc.allowance(user, address(bridge)), 0, "permit allowance fully consumed");
        assertEq(usdc.balanceOf(address(messenger)), 99_500_000);
        _assertNoBalanceOrAllowance();
    }

    function test_permit_frontRun_doesNotRevert() public {
        vm.prank(user);
        usdc.approve(address(bridge), 0);
        SettuBridge.Quote memory q = _quote();
        SettuBridge.Permit memory p = _signPermit(q.amount, block.timestamp + 600);
        bytes memory sig = _sign(q);

        // Someone submits the user's permit first; the bridge's own permit call then fails.
        usdc.permit(user, address(bridge), p.value, p.deadline, p.v, p.r, p.s);

        vm.prank(user);
        bridge.bridge(q, sig, p);
        assertEq(usdc.balanceOf(address(messenger)), 99_500_000);
    }

    function test_permit_invalidAndNoAllowance_reverts() public {
        vm.prank(user);
        usdc.approve(address(bridge), 0);
        SettuBridge.Quote memory q = _quote();
        SettuBridge.Permit memory p = _signPermit(q.amount, block.timestamp + 600);
        p.value = q.amount + 1; // signature no longer matches
        bytes memory sig = _sign(q);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(bridge), 0, q.settuFee)
        );
        bridge.bridge(q, sig, p);
    }

    // ------------------------------------------------------------ native value

    function test_revert_nativeValueBelowFee() public {
        SettuBridge.Quote memory q = _quote();
        q.nativeFee = 0.001 ether;
        _expectRevertBridge(q, _sign(q), 0.001 ether - 1, abi.encodeWithSelector(SettuBridge.WrongNativeValue.selector));
    }

    function test_revert_nativeValueAboveFee() public {
        SettuBridge.Quote memory q = _quote();
        q.nativeFee = 0.001 ether;
        _expectRevertBridge(q, _sign(q), 0.001 ether + 1, abi.encodeWithSelector(SettuBridge.WrongNativeValue.selector));
    }

    function test_revert_nativeValueWhenFeeIsZero() public {
        SettuBridge.Quote memory q = _quote();
        _expectRevertBridge(q, _sign(q), 1, abi.encodeWithSelector(SettuBridge.WrongNativeValue.selector));
    }

    function test_revert_nativeTransferFailed() public {
        RejectingFeeWallet rejecting = new RejectingFeeWallet();
        vm.prank(owner);
        bridge.setFeeWallet(address(rejecting));
        SettuBridge.Quote memory q = _quote();
        q.nativeFee = 0.001 ether;
        _expectRevertBridge(q, _sign(q), q.nativeFee, abi.encodeWithSelector(SettuBridge.NativeTransferFailed.selector));
    }

    function test_reentrancyFromFeeWallet_isBlocked() public {
        ReentrantFeeWallet evil = new ReentrantFeeWallet();
        vm.prank(owner);
        bridge.setFeeWallet(address(evil));

        SettuBridge.Quote memory q = _quote();
        q.nativeFee = 0.001 ether;
        SettuBridge.Quote memory q2 = _quote();
        q2.nonce = keccak256("nonce-2");
        q2.user = address(evil);
        evil.arm(address(bridge), abi.encodeCall(SettuBridge.bridge, (q2, _sign(q2), _noPermit())));

        _bridge(q);
        assertTrue(evil.attempted());
        assertEq(
            evil.reentryRevertData(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertFalse(bridge.usedNonces(q2.nonce));
        assertEq(address(evil).balance, q.nativeFee);
    }

    // ------------------------------------------------------------ limits

    function test_revert_networkFeeAboveMax() public {
        SettuBridge.Quote memory q = _quote();
        q.networkFee = MAX_NETWORK_FEE + 1;
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.NetworkFeeAboveMax.selector));
    }

    function test_revert_nativeFeeAboveMax() public {
        SettuBridge.Quote memory q = _quote();
        q.nativeFee = MAX_NATIVE_FEE + 1;
        _expectRevertBridge(q, _sign(q), q.nativeFee, abi.encodeWithSelector(SettuBridge.NativeFeeAboveMax.selector));
    }

    function test_revert_feeOverCap() public {
        SettuBridge.Quote memory q = _quote();
        q.settuFee = 1e6 + 1; // just over 1%
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.FeeAboveCap.selector));
    }

    function test_revert_feeOverLoweredCap() public {
        vm.prank(owner);
        bridge.setMaxFeeBps(10); // 0.1%
        SettuBridge.Quote memory q = _quote(); // 0.5%
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.FeeAboveCap.selector));
    }

    function test_revert_feesConsumeWholeAmount() public {
        SettuBridge.Quote memory q = _quote();
        q.amount = 1e6;
        q.settuFee = 0;
        q.networkFee = 1e6; // <= maxNetworkFee, but nothing left to burn
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.NothingToBurn.selector));
    }

    // ------------------------------------------------------------ quote validity

    function test_revert_expired() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.warp(q.deadline + 1);
        _expectRevertBridge(q, sig, 0, abi.encodeWithSelector(SettuBridge.QuoteExpired.selector));
    }

    function test_revert_reusedNonce() public {
        SettuBridge.Quote memory q = _quote();
        _bridge(q);
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.NonceUsed.selector));
    }

    function test_revert_reusedNonce_differentQuote() public {
        SettuBridge.Quote memory q = _quote();
        _bridge(q);
        q.amount = 50e6;
        q.settuFee = 0;
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.NonceUsed.selector));
    }

    function test_revert_wrongUser() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        usdc.mint(stranger, 1_000e6);
        vm.startPrank(stranger);
        usdc.approve(address(bridge), type(uint256).max);
        vm.expectRevert(SettuBridge.WrongUser.selector);
        bridge.bridge(q, sig, _noPermit());
        vm.stopPrank();
    }

    function test_revert_wrongSourceDomain() public {
        SettuBridge.Quote memory q = _quote();
        q.sourceDomain = 3; // Arbitrum quote replayed on Base
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.WrongSourceDomain.selector));
    }

    function test_revert_wrongAmount_tampered() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        q.amount = 200e6; // fee now within cap, but not what Settu signed
        _expectRevertBridge(q, sig, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_wrongAmount_exceedsBalance() public {
        SettuBridge.Quote memory q = _quote();
        q.amount = 2_000e6;
        q.settuFee = 0;
        _expectRevertBridge(
            q,
            _sign(q),
            0,
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, user, 1_000e6, 2_000e6)
        );
    }

    function test_revert_unsupportedVersion() public {
        SettuBridge.Quote memory q = _quote();
        q.version = 2;
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.UnsupportedVersion.selector));
    }

    // ------------------------------------------------------------ signatures

    function test_revert_tamperedSignature() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        sig[10] = bytes1(uint8(sig[10]) ^ 0x01);
        _expectRevertBridge(q, sig, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_tamperedQuoteField() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        q.mintRecipient = bytes32(uint256(0xdead));
        _expectRevertBridge(q, sig, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_tamperedHookData() public {
        SettuBridge.Quote memory q = _quote();
        q.hookData = hex"01";
        bytes memory sig = _sign(q);
        q.hookData = hex"02";
        _expectRevertBridge(q, sig, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_wrongSigner() public {
        SettuBridge.Quote memory q = _quote();
        _expectRevertBridge(q, _signWith(0xBAD, q), 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_badSignatureLength() public {
        SettuBridge.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; i++) {
            short[i] = sig[i];
        }
        _expectRevertBridge(q, short, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_revert_highSMalleatedSignature() public {
        SettuBridge.Quote memory q = _quote();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, bridge.hashQuote(q));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        _expectRevertBridge(q, malleated, 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
    }

    function test_signerRotation_invalidatesOldKey() public {
        vm.prank(owner);
        bridge.setSigner(vm.addr(0xC0FFEE));
        SettuBridge.Quote memory q = _quote();
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(SettuBridge.InvalidSignature.selector));
        bytes memory sig = _signWith(0xC0FFEE, q);
        vm.prank(user);
        bridge.bridge(q, sig, _noPermit());
    }

    // ------------------------------------------------------------ pause

    function test_revert_paused() public {
        vm.prank(owner);
        bridge.pause();
        SettuBridge.Quote memory q = _quote();
        _expectRevertBridge(q, _sign(q), 0, abi.encodeWithSelector(Pausable.EnforcedPause.selector));

        vm.prank(owner);
        bridge.unpause();
        _bridge(q);
        assertTrue(bridge.usedNonces(q.nonce));
    }

    // ------------------------------------------------------------ owner-only setters

    function _expectNotOwner(address who) internal {
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
    }

    function test_setters_rejectNonOwner() public {
        address[2] memory notOwners = [stranger, signer];
        for (uint256 i; i < notOwners.length; i++) {
            address who = notOwners[i];
            _expectNotOwner(who);
            bridge.setSigner(who);
            _expectNotOwner(who);
            bridge.setFeeWallet(who);
            _expectNotOwner(who);
            bridge.setMaxFeeBps(10_000);
            _expectNotOwner(who);
            bridge.setMaxNetworkFee(type(uint256).max);
            _expectNotOwner(who);
            bridge.setMaxNativeFee(type(uint256).max);
            _expectNotOwner(who);
            bridge.pause();
            _expectNotOwner(who);
            bridge.unpause();
            _expectNotOwner(who);
            bridge.transferOwnership(who);
        }
    }

    function test_setters_ownerCanSet() public {
        address newSigner = makeAddr("newSigner");
        address newFeeWallet = makeAddr("newFeeWallet");
        vm.startPrank(owner);

        vm.expectEmit(true, true, false, false, address(bridge));
        emit SettuBridge.SignerUpdated(signer, newSigner);
        bridge.setSigner(newSigner);
        assertEq(bridge.signer(), newSigner);

        vm.expectEmit(true, true, false, false, address(bridge));
        emit SettuBridge.FeeWalletUpdated(feeWallet, newFeeWallet);
        bridge.setFeeWallet(newFeeWallet);
        assertEq(bridge.feeWallet(), newFeeWallet);

        vm.expectEmit(false, false, false, true, address(bridge));
        emit SettuBridge.MaxFeeBpsUpdated(100, 50);
        bridge.setMaxFeeBps(50);
        assertEq(bridge.maxFeeBps(), 50);

        vm.expectEmit(false, false, false, true, address(bridge));
        emit SettuBridge.MaxNetworkFeeUpdated(MAX_NETWORK_FEE, 7e6);
        bridge.setMaxNetworkFee(7e6);
        assertEq(bridge.maxNetworkFee(), 7e6);

        vm.expectEmit(false, false, false, true, address(bridge));
        emit SettuBridge.MaxNativeFeeUpdated(MAX_NATIVE_FEE, 0.02 ether);
        bridge.setMaxNativeFee(0.02 ether);
        assertEq(bridge.maxNativeFee(), 0.02 ether);

        bridge.pause();
        assertTrue(bridge.paused());
        bridge.unpause();
        assertFalse(bridge.paused());
        vm.stopPrank();
    }

    function test_setters_rejectBadValues() public {
        vm.startPrank(owner);
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        bridge.setSigner(address(0));
        vm.expectRevert(SettuBridge.ZeroAddress.selector);
        bridge.setFeeWallet(address(0));
        vm.expectRevert(SettuBridge.InvalidBps.selector);
        bridge.setMaxFeeBps(10_001);
        bridge.setMaxFeeBps(10_000);
        vm.stopPrank();
    }

    function test_ownershipTransfer_isTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        bridge.transferOwnership(newOwner);
        assertEq(bridge.owner(), owner, "not transferred until accepted");
        assertEq(bridge.pendingOwner(), newOwner);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        bridge.acceptOwnership();

        vm.prank(newOwner);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), newOwner);

        _expectNotOwner(owner);
        bridge.pause();
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(SettuBridge.RenounceDisabled.selector);
        bridge.renounceOwnership();
        assertEq(bridge.owner(), owner);
    }

    function test_rejectsPlainNativeTransfer() public {
        vm.prank(user);
        (bool ok,) = address(bridge).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_conservation(uint256 amount, uint256 settuFee, uint256 networkFee, uint256 nativeFee) public {
        amount = bound(amount, 2, 1_000e6);
        settuFee = bound(settuFee, 0, amount / 100);
        networkFee = bound(networkFee, 0, MAX_NETWORK_FEE);
        nativeFee = bound(nativeFee, 0, MAX_NATIVE_FEE);
        vm.assume(settuFee + networkFee < amount);

        SettuBridge.Quote memory q = _quote();
        q.amount = amount;
        q.settuFee = settuFee;
        q.networkFee = networkFee;
        q.nativeFee = nativeFee;
        uint256 userBefore = usdc.balanceOf(user);
        _bridge(q);

        assertEq(usdc.balanceOf(feeWallet), settuFee + networkFee);
        assertEq(usdc.balanceOf(address(messenger)), amount - settuFee - networkFee);
        assertEq(userBefore - usdc.balanceOf(user), amount);
        assertEq(feeWallet.balance, nativeFee);
        _assertNoBalanceOrAllowance();
    }

    // ------------------------------------------------------------ golden vector (Task 5)

    struct Vector {
        uint256 chainId;
        address verifyingContract;
        SettuBridge.Quote quote;
        bytes32 digest;
        bytes signature;
        address signer;
    }

    function _loadEvmVector() internal view returns (Vector memory v) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/quotes.json"));
        assertEq(vm.parseJsonString(json, ".cases[0].name"), "evm");
        assertEq(vm.parseJsonBytes32(json, ".evm.typeHash"), bridge.QUOTE_TYPEHASH(), "typehash vs vector");
        string memory p = ".cases[0].quote";
        v.chainId = vm.parseJsonUint(json, ".cases[0].chainId");
        v.verifyingContract = vm.parseJsonAddress(json, ".cases[0].verifyingContract");
        v.quote = SettuBridge.Quote({
            version: uint8(vm.parseJsonUint(json, string.concat(p, ".version"))),
            sourceDomain: uint32(vm.parseJsonUint(json, string.concat(p, ".sourceDomain"))),
            destDomain: uint32(vm.parseJsonUint(json, string.concat(p, ".destDomain"))),
            user: vm.parseJsonAddress(json, string.concat(p, ".user")),
            amount: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".amount"))),
            settuFee: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".settuFee"))),
            networkFee: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".networkFee"))),
            nativeFee: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".nativeFee"))),
            mintRecipient: vm.parseJsonBytes32(json, string.concat(p, ".mintRecipient")),
            hookData: vm.parseJsonBytes(json, string.concat(p, ".hookData")),
            maxFee: vm.parseUint(vm.parseJsonString(json, string.concat(p, ".maxFee"))),
            minFinality: uint32(vm.parseJsonUint(json, string.concat(p, ".minFinality"))),
            deadline: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(p, ".deadline")))),
            nonce: vm.parseJsonBytes32(json, string.concat(p, ".nonce"))
        });
        v.digest = vm.parseJsonBytes32(json, ".cases[0].digest");
        v.signature = vm.parseJsonBytes(json, ".cases[0].signature");
        v.signer = vm.parseJsonAddress(json, ".cases[0].signer");
    }

    function _deployAt(address at, address signer_) internal returns (SettuBridge b) {
        deployCodeTo(
            "SettuBridge.sol:SettuBridge",
            abi.encode(
                address(usdc),
                address(messenger),
                LOCAL_DOMAIN,
                signer_,
                feeWallet,
                owner,
                MAX_NETWORK_FEE,
                MAX_NATIVE_FEE
            ),
            at
        );
        b = SettuBridge(at);
    }

    function test_goldenVector_digestAndSigner() public {
        Vector memory v = _loadEvmVector();
        vm.chainId(v.chainId);
        SettuBridge b = _deployAt(v.verifyingContract, v.signer);

        assertEq(b.hashQuote(v.quote), v.digest, "digest vs vector");
        assertEq(ECDSA.recover(v.digest, v.signature), v.signer, "recovered signer vs vector");
    }

    function test_goldenVector_bridgesEndToEnd() public {
        Vector memory v = _loadEvmVector();
        vm.chainId(v.chainId);
        SettuBridge b = _deployAt(v.verifyingContract, v.signer);
        assertEq(b.localDomain(), v.quote.sourceDomain);

        address vUser = v.quote.user;
        usdc.mint(vUser, v.quote.amount);
        vm.deal(vUser, v.quote.nativeFee);
        vm.warp(v.quote.deadline - 60);
        vm.startPrank(vUser);
        usdc.approve(address(b), v.quote.amount);
        b.bridge{value: v.quote.nativeFee}(v.quote, v.signature, _noPermit());
        vm.stopPrank();

        assertEq(usdc.balanceOf(feeWallet), v.quote.settuFee + v.quote.networkFee);
        assertEq(feeWallet.balance, v.quote.nativeFee);
        assertEq(usdc.balanceOf(address(messenger)), v.quote.amount - v.quote.settuFee - v.quote.networkFee);
        assertEq(messenger.lastHookData(), v.quote.hookData);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertTrue(b.usedNonces(v.quote.nonce));
    }

    function test_goldenVector_wrongChainIdFails() public {
        Vector memory v = _loadEvmVector();
        vm.chainId(1);
        SettuBridge b = _deployAt(v.verifyingContract, v.signer);
        assertTrue(b.hashQuote(v.quote) != v.digest, "domain must bind chainId");
    }
}
