// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAerodromeAutocompounder {
    function harvestAndCompound(uint256 minAssetOut, uint256 profitShareBps) external;
    function pullProfit(uint256 amount, address to) external;
    function depositIntoPool(uint256 usdcAmount, uint256 minLpOut) external;
    function pendingProfit() external view returns (uint256);
}

/**
 * @title YieldSenseKeeper
 * @notice Multi-user ERC-4626 vault with Acurast TEE-authorized trade auditing.
 *
 * Accounting model (MVP):
 *  - Yield is distributed to all depositors proportionally via executeHarvest (mutualized).
 *  - executeTrade verifies TEE-signed trade proofs and records them as on-chain events
 *    for off-chain indexing. It does NOT mint/burn shares — isolated per-user PnL via
 *    ERC-4626 share-price adjustments is mathematically impossible without diluting all
 *    other shareholders. A per-user ledger upgrade is tracked for a future release.
 *  - Performance fees are taken as newly minted shares on harvest profit only.
 */
contract YieldSenseKeeper is ERC4626, ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TIMELOCK_DELAY = 2 days;
    uint256 public constant MIN_HARVEST_INTERVAL = 1 hours;

    struct PendingAddress {
        address value;
        uint64 effectiveTime;
    }

    address public feeRecipient;
    address public yieldSource;
    address public counterparty;

    IAerodromeAutocompounder public autocompounder;
    uint256 public profitShareBps = 2000;
    uint256 public minHarvestProfitUsdc = 1e6;

    bytes32 public attestationRootQx;
    bytes32 public attestationRootQy;

    mapping(address => bool) public attestedProcessors;
    /// @notice Maps a user address to their provisioned Acurast processor.
    mapping(address => address) public userProcessors;

    mapping(bytes32 => PendingAddress) public pendingUpdates;
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;

    uint256 public lastHarvest;

    event TradeExecuted(address indexed user, int256 pnlDelta, uint256 nonce, bytes32 indexed digest);
    event HarvestExecuted(bytes32 indexed payloadHash, uint256 profitCredited);
    event PoolDeployed(uint256 usdcAmount, uint256 minLpOut);
    event UpdateInitiated(bytes32 indexed key, address indexed newValue, uint256 effectiveTime);
    event UpdateApplied(bytes32 indexed key, address indexed newValue);
    event ProcessorAttested(address indexed processor, bytes32 certHash);
    event ProcessorAssigned(address indexed user, address indexed processor);
    event AttestationRootUpdated(bytes32 qx, bytes32 qy);
    event AutocompounderSet(address indexed autocompounder);
    event ProfitCredited(uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InsufficientBalance();
    error TimelockNotExpired();
    error NoUpdatePending();
    error ProcessorNotAttested();
    error ProcessorNotAssignedToUser();
    error InvalidAttestationSignature();
    error HarvestTooFrequent();
    error NoProfitReceived();

    constructor(
        address asset_,
        address yieldSource_,
        address counterparty_,
        address autocompounder_
    ) ERC4626(IERC20(asset_)) ERC20("YieldSense Vault", "YSV") Ownable(msg.sender) {
        if (asset_ == address(0)) revert InvalidAddress();
        feeRecipient = msg.sender;
        yieldSource = yieldSource_;
        counterparty = counterparty_;
        if (autocompounder_ != address(0)) {
            autocompounder = IAerodromeAutocompounder(autocompounder_);
        }
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── USER PROCESSOR MAPPING ───────────────────────────────────────────────

    /**
     * @notice Binds the caller to a specific Acurast processor.
     * @dev The processor must already be attested before a user can assign it.
     *      This binding is enforced in executeTrade: only the assigned processor's
     *      signed payloads are accepted for a given user.
     * @param processor The secp256k1 Ethereum address of the Acurast processor.
     */
    function assignProcessor(address processor) external {
        if (processor == address(0)) revert InvalidAddress();
        if (!attestedProcessors[processor]) revert ProcessorNotAttested();
        userProcessors[msg.sender] = processor;
        emit ProcessorAssigned(msg.sender, processor);
    }

    // ─── P-256 TEE ATTESTATION ────────────────────────────────────────────────

    /**
     * @notice Sets the Acurast P-256 certificate authority public key.
     *         Must be called before permissionless attestProcessor() can succeed.
     */
    function setAttestationRoot(bytes32 qx, bytes32 qy) external onlyOwner {
        attestationRootQx = qx;
        attestationRootQy = qy;
        emit AttestationRootUpdated(qx, qy);
    }

    /**
     * @notice Permissionless attestation: verifies a P-256 TEE certificate.
     * @dev Requires setAttestationRoot() to have been called first with the
     *      Acurast CA public key. The certHash, r, s must be a valid P-256
     *      signature from the Acurast CA over the processor's certificate hash.
     */
    function attestProcessor(
        address processor,
        bytes32 certHash,
        bytes32 r,
        bytes32 s
    ) external {
        if (processor == address(0)) revert InvalidAddress();
        if (attestationRootQx == bytes32(0)) revert InvalidAttestationSignature();

        bool valid = P256.verify(certHash, r, s, attestationRootQx, attestationRootQy);
        if (!valid) revert InvalidAttestationSignature();

        attestedProcessors[processor] = true;
        emit ProcessorAttested(processor, certHash);
    }

    /**
     * @notice Admin bypass for attestation used during MVP while the permissionless
     *         P-256 attestation flow (attestProcessor) is being integrated with the
     *         live Acurast CA certificate chain. Should be removed in production.
     */
    function ownerAttestProcessor(address processor) external onlyOwner {
        if (processor == address(0)) revert InvalidAddress();
        attestedProcessors[processor] = true;
        emit ProcessorAttested(processor, bytes32(0));
    }

    function revokeProcessor(address processor) external onlyOwner {
        attestedProcessors[processor] = false;
    }

    // ─── TIMELOCK SETTERS ─────────────────────────────────────────────────────

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
        else revert("Invalid Key");

        delete pendingUpdates[key];
        emit UpdateApplied(key, pending.value);
    }

    // ─── CORE LOGIC ───────────────────────────────────────────────────────────

    /**
     * @notice Records a TEE-signed trade proof on-chain for auditability.
     *
     * IMPORTANT — accounting model:
     *   This function intentionally does NOT mint or burn shares.
     *   Per-user isolated PnL is not achievable via ERC-4626 share price adjustments
     *   without proportionally impacting all other shareholders. All user yield is
     *   distributed through executeHarvest (mutualized). Grid trading PnL is
     *   recorded here purely as a verifiable audit trail for off-chain indexers.
     *
     * @param user      The user whose strategy generated this trade.
     * @param pnlDelta  Signed PnL in asset units (positive = profit, negative = loss).
     * @param nonce     Replay-prevention nonce (use monotonic counter from _STD_.storage).
     * @param signature secp256k1 signature from the user's assigned Acurast processor.
     */
    function executeTrade(
        address user,
        int256 pnlDelta,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (user == address(0)) revert InvalidAddress();
        _useNonce(user, nonce);

        bytes32 digest = keccak256(abi.encodePacked(block.chainid, address(this), user, pnlDelta, nonce));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);

        if (!attestedProcessors[recovered]) revert ProcessorNotAttested();
        if (userProcessors[user] != recovered) revert ProcessorNotAssignedToUser();

        emit TradeExecuted(user, pnlDelta, nonce, digest);
    }

    /**
     * @notice Triggers a harvest+compound cycle and credits real profit into the vault.
     *         Profit increases totalAssets() without new shares, raising share price
     *         for all depositors proportionally (mutualized yield distribution).
     * @param payloadHash Hash of the harvest parameters signed by the processor.
     * @param r           ECDSA signature component.
     * @param s           ECDSA signature component.
     * @param v           ECDSA recovery id (27 or 28).
     * @param minAssetOut Minimum USDC to accept from the autocompounder swap (slippage guard).
     */
    function executeHarvest(
        bytes32 payloadHash,
        bytes32 r,
        bytes32 s,
        uint8 v,
        uint256 minAssetOut
    ) external nonReentrant whenNotPaused {
        if (block.timestamp < lastHarvest + MIN_HARVEST_INTERVAL) revert HarvestTooFrequent();

        bytes memory signature = abi.encodePacked(r, s, v);
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(payloadHash);
        address recovered = ECDSA.recover(ethHash, signature);

        if (!attestedProcessors[recovered]) revert ProcessorNotAttested();

        lastHarvest = block.timestamp;
        uint256 profitCredited = 0;

        if (address(autocompounder) != address(0)) {
            autocompounder.harvestAndCompound(minAssetOut, profitShareBps);

            uint256 pending = autocompounder.pendingProfit();
            if (pending >= minHarvestProfitUsdc) {
                uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));
                autocompounder.pullProfit(pending, address(this));
                uint256 actualProfit = IERC20(asset()).balanceOf(address(this)) - balanceBefore;

                if (actualProfit == 0) revert NoProfitReceived();
                profitCredited = actualProfit;

                // Performance fee: mint shares to feeRecipient backed by the fee portion
                // of the profit already in the vault. This slightly dilutes other holders
                // by the fee amount, which is the intended on-chain fee mechanism.
                uint256 perfFee = (profitCredited * PERFORMANCE_FEE_BPS) / BPS_DENOMINATOR;
                if (perfFee > 0) {
                    uint256 feeShares = previewDeposit(perfFee);
                    _mint(feeRecipient, feeShares);
                }

                emit ProfitCredited(profitCredited);
            }
        }

        emit HarvestExecuted(payloadHash, profitCredited);
    }

    /**
     * @notice Deploys idle vault assets into the yield-bearing pool.
     * @dev Restricted to owner only. Attested processors should signal deployment
     *      need via off-chain telemetry; owner executes on-chain.
     */
    function deployToPool(uint256 amount, uint256 minLpOut)
        external
        nonReentrant
        onlyOwner
    {
        if (address(autocompounder) == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(asset()).forceApprove(address(autocompounder), amount);
        autocompounder.depositIntoPool(amount, minLpOut);

        emit PoolDeployed(amount, minLpOut);
    }

    function setAutocompounder(address newAutocompounder) external onlyOwner {
        autocompounder = IAerodromeAutocompounder(newAutocompounder);
        emit AutocompounderSet(newAutocompounder);
    }

    function setProfitShareBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "Invalid BPS");
        profitShareBps = bps;
    }

    function setMinHarvestProfitUsdc(uint256 minUsdc) external onlyOwner {
        minHarvestProfitUsdc = minUsdc;
    }

    // ─── ERC-4626 OVERRIDES ───────────────────────────────────────────────────

    /**
     * @notice Enforce pause on standard ERC-4626 deposit/withdraw entry points.
     */
    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────────

    function _useNonce(address user, uint256 nonce) internal {
        uint256 wordPos = nonce >> 8;
        uint256 bitPos = nonce & 0xff;
        uint256 mask = 1 << bitPos;
        uint256 flipped = _nonceBitmap[user][wordPos] ^ mask;
        if (flipped & mask == 0) revert NonceAlreadyUsed();
        _nonceBitmap[user][wordPos] = flipped;
    }
}
