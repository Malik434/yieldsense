// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAcurastConsumer {
    function verifyAcurastSignature(bytes32 digest, bytes calldata signature) external view returns (bool);
}

/**
 * @title YieldSenseKeeper
 * @notice Strategy vault with Acurast TEE-authorized trade execution.
 */
contract YieldSenseKeeper is IAcurastConsumer, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TIMELOCK_DELAY = 2 days;

    struct UserData {
        uint128 balance;
        uint128 initialDeposit;
    }

    struct PendingAddress {
        address value;
        uint64 effectiveTime;
    }

    IERC20 public immutable asset;
    address public feeRecipient;
    address public acurastSigner;
    address public yieldSource;
    address public counterparty;

    // Security: Timelock for critical addresses
    mapping(bytes32 => PendingAddress) public pendingUpdates;

    // Gas: Struct packing for user data
    mapping(address => UserData) public userData;
    
    // Gas: Nonce bitmap (256 nonces per slot)
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;

    uint256 public lastHarvest;

    event Deposited(address indexed user, uint256 amount, uint256 balanceAfter);
    event TradeExecuted(address indexed user, int256 pnlDelta, uint256 nonce, bytes32 indexed digest);
    event HarvestExecuted(bytes32 indexed payloadHash);
    event Withdrawn(address indexed user, uint256 grossAmount, uint256 performanceFee, uint256 netAmount);
    event UpdateInitiated(bytes32 indexed key, address indexed newValue, uint256 effectiveTime);
    event UpdateApplied(bytes32 indexed key, address indexed newValue);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InsufficientBalance();
    error TimelockNotExpired();
    error NoUpdatePending();

    constructor(address asset_, address acurastSigner_) Ownable(msg.sender) {
        if (asset_ == address(0) || acurastSigner_ == address(0)) revert InvalidAddress();
        asset = IERC20(asset_);
        feeRecipient = msg.sender;
        acurastSigner = acurastSigner_;
    }

    // --- TIMELOCK SETTERS ---

    function initiateUpdate(bytes32 key, address newValue) external onlyOwner {
        if (newValue == address(0)) revert InvalidAddress();
        uint64 effectiveTime = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingUpdates[key] = PendingAddress(newValue, effectiveTime);
        emit UpdateInitiated(key, newValue, effectiveTime);
    }

    function applyUpdate(bytes32 key) external onlyOwner {
        PendingAddress memory pending = pendingUpdates[key];
        if (pending.effectiveTime == 0) revert NoUpdatePending();
        if (block.timestamp < pending.effectiveTime) revert TimelockNotExpired();

        if (key == "yieldSource") yieldSource = pending.value;
        else if (key == "counterparty") counterparty = pending.value;
        else if (key == "feeRecipient") feeRecipient = pending.value;
        else if (key == "acurastSigner") acurastSigner = pending.value;
        else revert("Invalid Key");

        delete pendingUpdates[key];
        emit UpdateApplied(key, pending.value);
    }

    // --- CORE LOGIC ---

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        
        asset.safeTransferFrom(msg.sender, address(this), amount);

        UserData storage user = userData[msg.sender];
        user.balance += uint128(amount);
        user.initialDeposit += uint128(amount);

        emit Deposited(msg.sender, amount, user.balance);
    }

    /**
     * @notice Applies signed PnL delta. 
     * @dev digest is computed internally to prevent parameter manipulation.
     */
    function executeTrade(
        address user,
        int256 pnlDelta,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        if (user == address(0)) revert InvalidAddress();
        _useNonce(user, nonce);

        // Compute digest internally
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), user, pnlDelta, nonce));
        
        if (!verifyAcurastSignature(digest, signature)) revert InvalidSignature();

        UserData storage data = userData[user];
        if (pnlDelta > 0) {
            uint256 profit = uint256(pnlDelta);
            data.balance += uint128(profit);
            asset.safeTransferFrom(yieldSource, address(this), profit); 
        } else if (pnlDelta < 0) {
            uint256 loss = uint256(-pnlDelta);
            if (data.balance < loss) revert InsufficientBalance();
            data.balance -= uint128(loss);
            asset.safeTransfer(counterparty, loss);
        }

        emit TradeExecuted(user, pnlDelta, nonce, digest);
    }

    /**
     * @notice Applies signed harvest trigger to update lastHarvest timestamp.
     */
    function executeHarvest(
        bytes32 payloadHash,
        bytes32 r,
        bytes32 s,
        uint8 v
    ) external nonReentrant {
        bytes memory signature = abi.encodePacked(r, s, v);
        if (!verifyAcurastSignature(payloadHash, signature)) revert InvalidSignature();

        lastHarvest = block.timestamp;

        emit HarvestExecuted(payloadHash);
    }

    function withdraw() external nonReentrant {
        UserData memory data = userData[msg.sender];
        if (data.balance == 0) revert InsufficientBalance();

        uint256 profit = data.balance > data.initialDeposit ? data.balance - data.initialDeposit : 0;
        uint256 performanceFee = profit > 0 ? (profit * PERFORMANCE_FEE_BPS) / BPS_DENOMINATOR : 0;
        uint256 netAmount = data.balance - performanceFee;

        // CEI Pattern
        delete userData[msg.sender];

        if (performanceFee > 0) {
            asset.safeTransfer(feeRecipient, performanceFee);
        }
        asset.safeTransfer(msg.sender, netAmount);

        emit Withdrawn(msg.sender, data.balance, performanceFee, netAmount);
    }

    // --- HELPERS ---

    function verifyAcurastSignature(bytes32 digest, bytes calldata signature) public view override returns (bool) {
        bytes32 ethHash = ECDSA.toEthSignedMessageHash(digest);
        return ECDSA.recover(ethHash, signature) == acurastSigner;
    }

    function _useNonce(address user, uint256 nonce) internal {
        uint256 wordPos = nonce >> 8;
        uint256 bitPos = nonce & 0xff;
        uint256 mask = 1 << bitPos;
        uint256 flipped = _nonceBitmap[user][wordPos] ^ mask;
        if (flipped & mask == 0) revert NonceAlreadyUsed();
        _nonceBitmap[user][wordPos] = flipped;
    }
}