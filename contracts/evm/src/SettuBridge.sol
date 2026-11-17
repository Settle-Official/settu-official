// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Circle CCTP V2 TokenMessengerV2 (evm-cctp-contracts, src/v2/TokenMessengerV2.sol).
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @title SettuBridge
/// @notice Bridges a user's USDC through Circle CCTP V2 in one call, taking the
/// fees in a Settu-signed EIP-712 quote. The contract never holds a balance
/// after a call: fees go straight from the user to `feeWallet`, and the rest is
/// pulled in and burned in the same transaction.
contract SettuBridge is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @dev Field order and types are part of the protocol and must match
    /// `EVM_QUOTE_TYPES` in src/lib/bridge/quote.ts.
    struct Quote {
        uint8 version;
        uint32 sourceDomain;
        uint32 destDomain;
        address user;
        uint256 amount;
        uint256 settuFee;
        uint256 networkFee;
        uint256 nativeFee;
        bytes32 mintRecipient;
        bytes hookData;
        uint256 maxFee;
        uint32 minFinality;
        uint64 deadline;
        bytes32 nonce;
    }

    /// @notice Optional EIP-2612 permit for `usdc`, used when `use` is true.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
        bool use;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 version,uint32 sourceDomain,uint32 destDomain,address user,uint256 amount,uint256 settuFee,uint256 networkFee,uint256 nativeFee,bytes32 mintRecipient,bytes hookData,uint256 maxFee,uint32 minFinality,uint64 deadline,bytes32 nonce)"
    );
    uint8 public constant QUOTE_VERSION = 1;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable localDomain;

    address public signer;
    address public feeWallet;
    uint256 public maxFeeBps = 100; // 1%
    uint256 public maxNetworkFee;
    uint256 public maxNativeFee;
    mapping(bytes32 nonce => bool) public usedNonces;

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
    event SignerUpdated(address indexed previous, address indexed current);
    event FeeWalletUpdated(address indexed previous, address indexed current);
    event MaxFeeBpsUpdated(uint256 previous, uint256 current);
    event MaxNetworkFeeUpdated(uint256 previous, uint256 current);
    event MaxNativeFeeUpdated(uint256 previous, uint256 current);

    error ZeroAddress();
    error InvalidBps();
    error RenounceDisabled();
    error UnsupportedVersion();
    error QuoteExpired();
    error NonceUsed();
    error WrongUser();
    error WrongSourceDomain();
    error FeeAboveCap();
    error NetworkFeeAboveMax();
    error NativeFeeAboveMax();
    error NothingToBurn();
    error InvalidSignature();
    error WrongNativeValue();
    error NativeTransferFailed();

    constructor(
        address usdc_,
        address tokenMessenger_,
        uint32 localDomain_,
        address signer_,
        address feeWallet_,
        address owner_,
        uint256 maxNetworkFee_,
        uint256 maxNativeFee_
    ) Ownable(owner_) EIP712("SettuBridge", "1") {
        if (usdc_ == address(0) || tokenMessenger_ == address(0) || signer_ == address(0) || feeWallet_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        localDomain = localDomain_;
        signer = signer_;
        feeWallet = feeWallet_;
        maxNetworkFee = maxNetworkFee_;
        maxNativeFee = maxNativeFee_;
        emit SignerUpdated(address(0), signer_);
        emit FeeWalletUpdated(address(0), feeWallet_);
        emit MaxFeeBpsUpdated(0, maxFeeBps);
        emit MaxNetworkFeeUpdated(0, maxNetworkFee_);
        emit MaxNativeFeeUpdated(0, maxNativeFee_);
    }

    // ------------------------------------------------------------ bridge

    /// @notice Pays the quoted fees and burns the rest of `q.amount` through CCTP.
    /// @dev The caller must be `q.user`, must have approved this contract for
    /// `q.amount` USDC (or pass a permit), and must send exactly `q.nativeFee`.
    function bridge(Quote calldata q, bytes calldata sig, Permit calldata p)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        // Checks
        if (q.version != QUOTE_VERSION) revert UnsupportedVersion();
        if (block.timestamp > q.deadline) revert QuoteExpired();
        if (usedNonces[q.nonce]) revert NonceUsed();
        if (q.user != msg.sender) revert WrongUser();
        if (q.sourceDomain != localDomain) revert WrongSourceDomain();
        if (q.settuFee * BPS_DENOMINATOR > maxFeeBps * q.amount) revert FeeAboveCap();
        if (q.networkFee > maxNetworkFee) revert NetworkFeeAboveMax();
        if (q.nativeFee > maxNativeFee) revert NativeFeeAboveMax();
        if (msg.value != q.nativeFee) revert WrongNativeValue();
        uint256 usdcFee = q.settuFee + q.networkFee;
        if (usdcFee >= q.amount) revert NothingToBurn();
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hashQuote(q), sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert InvalidSignature();

        // Effects
        usedNonces[q.nonce] = true;

        // Interactions
        if (p.use) _tryPermit(p);
        uint256 burnAmount = q.amount - usdcFee;
        _collectFees(usdcFee, q.nativeFee);
        _burn(q, burnAmount);
        _emitBridged(q);
    }

    /// @dev A front-run permit (allowance already set) must not block the bridge;
    /// if the allowance is really missing, the transferFrom that follows reverts.
    function _tryPermit(Permit calldata p) private {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), p.value, p.deadline, p.v, p.r, p.s) {}
            catch {}
    }

    /// @dev USDC fees go straight from the user to the fee wallet; the native fee
    /// (exactly msg.value, checked by the caller) is forwarded with a checked call.
    function _collectFees(uint256 usdcFee, uint256 nativeFee) private {
        address feeWallet_ = feeWallet;
        if (usdcFee > 0) usdc.safeTransferFrom(msg.sender, feeWallet_, usdcFee);
        if (nativeFee > 0) {
            (bool ok,) = feeWallet_.call{value: nativeFee}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    /// @dev Pulls `burnAmount` from the user, approves exactly that, and burns it.
    /// TokenMessengerV2 transferFroms the full approval, so no allowance lingers.
    function _burn(Quote calldata q, uint256 burnAmount) private {
        usdc.safeTransferFrom(msg.sender, address(this), burnAmount);
        usdc.forceApprove(address(tokenMessenger), burnAmount);
        if (q.hookData.length == 0) {
            tokenMessenger.depositForBurn(
                burnAmount, q.destDomain, q.mintRecipient, address(usdc), bytes32(0), q.maxFee, q.minFinality
            );
        } else {
            tokenMessenger.depositForBurnWithHook(
                burnAmount,
                q.destDomain,
                q.mintRecipient,
                address(usdc),
                bytes32(0),
                q.maxFee,
                q.minFinality,
                q.hookData
            );
        }
    }

    function _emitBridged(Quote calldata q) private {
        emit Bridged(
            q.nonce,
            q.user,
            q.amount,
            q.settuFee,
            q.networkFee,
            q.nativeFee,
            q.destDomain,
            q.mintRecipient,
            q.minFinality
        );
    }

    /// @notice The EIP-712 digest the quote signer signs for this contract and chain.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        // Two static-only abi.encode halves concatenate to the same bytes as one
        // abi.encode of all 15 words; split only to stay under the stack limit.
        bytes memory head = abi.encode(
            QUOTE_TYPEHASH, q.version, q.sourceDomain, q.destDomain, q.user, q.amount, q.settuFee, q.networkFee
        );
        bytes memory tail = abi.encode(
            q.nativeFee, q.mintRecipient, keccak256(q.hookData), q.maxFee, q.minFinality, q.deadline, q.nonce
        );
        return _hashTypedDataV4(keccak256(bytes.concat(head, tail)));
    }

    // ------------------------------------------------------------ owner

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        emit SignerUpdated(signer, signer_);
        signer = signer_;
    }

    function setFeeWallet(address feeWallet_) external onlyOwner {
        if (feeWallet_ == address(0)) revert ZeroAddress();
        emit FeeWalletUpdated(feeWallet, feeWallet_);
        feeWallet = feeWallet_;
    }

    function setMaxFeeBps(uint256 maxFeeBps_) external onlyOwner {
        if (maxFeeBps_ > BPS_DENOMINATOR) revert InvalidBps();
        emit MaxFeeBpsUpdated(maxFeeBps, maxFeeBps_);
        maxFeeBps = maxFeeBps_;
    }

    function setMaxNetworkFee(uint256 maxNetworkFee_) external onlyOwner {
        emit MaxNetworkFeeUpdated(maxNetworkFee, maxNetworkFee_);
        maxNetworkFee = maxNetworkFee_;
    }

    function setMaxNativeFee(uint256 maxNativeFee_) external onlyOwner {
        emit MaxNativeFeeUpdated(maxNativeFee, maxNativeFee_);
        maxNativeFee = maxNativeFee_;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev An ownerless bridge could never be paused or have its signer rotated.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
