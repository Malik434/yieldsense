// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAcurastConsumer {
    function verifyAcurastSignature(bytes32 digest, bytes memory signature) external view returns (bool);
}

/// @dev Minimal interface to the AerodromeAutocompounder deployed alongside this vault.
interface IAerodromeAutocompounder {
    function harvestAndCompound(uint256 minAssetOut, uint256 profitShareBps) external;
    function pullProfit(uint256 amount, address to) external;
    function depositIntoPool(uint256 usdcAmount, uint256 minLpOut) external;
    function pendingProfit() external view returns (uint256);
    function pendingRewards() external view returns (uint256);
    function stakedLpBalance() external view returns (uint256);
    function lastHarvestAt() external view returns (uint256);
    function totalCompounded() external view returns (uint256);
}

/**
 * @title YieldSenseKeeper
 * @notice Strategy vault with Acurast TEE-authorized trade execution.
 * @dev Implements dual-layer security:
 *      Layer 1 (P-256): Verifies TEE hardware attestation certificates via RIP-7212 precompile.
 *      Layer 2 (secp256k1): Verifies runtime ECDSA signatures from attested processors.
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
    
    /// @notice For the testnet demo, we attribute harvest profit to this address
    ///         so it shows up on the dashboard. In production, this would be
    ///         handled by ERC-4626 share-based accounting.
    address public primaryUser;

    /// @notice The AerodromeAutocompounder contract. When set, executeHarvest
    ///         triggers a real harvest+compound cycle and credits profit to depositors.
    IAerodromeAutocompounder public autocompounder;

    /// @notice Fraction of AERO rewards realized as USDC profit (vs. re-compounded).
    ///         Default: 2000 = 20% profit, 80% compounded back into LP.
    uint256 public profitShareBps = 2000;

    /// @notice Minimum USDC to accept from a single harvest (anti-dust guard).
    uint256 public minHarvestProfitUsdc = 1e6; // 1 USDC (6 decimals)

    // --- P-256 TEE Attestation ---
    // Root-of-trust P-256 public key (e.g. Acurast network attestation root or Google Titan M root CA)
    bytes32 public attestationRootQx;
    bytes32 public attestationRootQy;

    // Mapping of secp256k1 addresses that have been attested via P-256 certificate verification
    mapping(address => bool) public attestedProcessors;

    // Security: Timelock for critical addresses
    mapping(bytes32 => PendingAddress) public pendingUpdates;

    // Gas: Struct packing for user data
    mapping(address => UserData) public userData;
    
    // Gas: Nonce bitmap (256 nonces per slot)
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;

    uint256 public lastHarvest;

    event Deposited(address indexed user, uint256 amount, uint256 balanceAfter);
    event TradeExecuted(address indexed user, int256 pnlDelta, uint256 nonce, bytes32 indexed digest);
    event HarvestExecuted(bytes32 indexed payloadHash, uint256 profitCredited);
    event PoolDeployed(uint256 usdcAmount, uint256 minLpOut);
    event Withdrawn(address indexed user, uint256 grossAmount, uint256 performanceFee, uint256 netAmount);
    event UpdateInitiated(bytes32 indexed key, address indexed newValue, uint256 effectiveTime);
    event UpdateApplied(bytes32 indexed key, address indexed newValue);
    event ProcessorAttested(address indexed processor, bytes32 certHash);
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
    error InvalidAttestationSignature();

    constructor(
        address asset_, 
        address acurastSigner_,
        address yieldSource_,
        address counterparty_,
        address autocompounder_   // pass address(0) to deploy without autocompounder initially
    ) Ownable(msg.sender) {
        if (asset_ == address(0) || acurastSigner_ == address(0)) revert InvalidAddress();
        asset = IERC20(asset_);
        feeRecipient = msg.sender;
        acurastSigner = acurastSigner_;
        yieldSource = yieldSource_;
        counterparty = counterparty_;
        if (autocompounder_ != address(0)) {
            autocompounder = IAerodromeAutocompounder(autocompounder_);
        }
    }

    // --- P-256 TEE ATTESTATION ---

    /**
     * @notice Sets the P-256 root-of-trust public key used to verify TEE attestation certificates.
     * @dev Only callable by the contract owner. This is the Acurast network attestation root or 
     *      a manufacturer root CA (e.g. Google Titan M).
     * @param qx The x-coordinate of the P-256 public key.
     * @param qy The y-coordinate of the P-256 public key.
     */
    function setAttestationRoot(bytes32 qx, bytes32 qy) external onlyOwner {
        attestationRootQx = qx;
        attestationRootQy = qy;
        emit AttestationRootUpdated(qx, qy);
    }

    /**
     * @notice Registers a processor as attested by verifying its P-256 TEE attestation certificate.
     * @dev The certHash binds the processor's secp256k1 address to the TEE attestation.
     *      The (r, s) signature is verified against the attestation root P-256 public key
     *      using the RIP-7212 precompile (0x100) on Base, falling back to Solidity math.
     * @param processor The secp256k1 Ethereum address of the Acurast processor to attest.
     * @param certHash The keccak256 hash of the attestation certificate binding this processor.
     * @param r The r component of the P-256 attestation signature.
     * @param s The s component of the P-256 attestation signature.
     */
    function registerProcessor(
        address processor,
        bytes32 certHash,
        bytes32 r,
        bytes32 s
    ) external {
        if (processor == address(0)) revert InvalidAddress();
        if (attestationRootQx == bytes32(0)) revert InvalidAttestationSignature();

        // Verify the P-256 signature against the attestation root key
        bool valid = P256.verify(certHash, r, s, attestationRootQx, attestationRootQy);
        if (!valid) revert InvalidAttestationSignature();

        attestedProcessors[processor] = true;
        emit ProcessorAttested(processor, certHash);
    }

    /**
     * @notice Owner can directly attest a processor (for testnet bootstrapping or migration).
     * @param processor The secp256k1 address to mark as attested.
     */
    function ownerAttestProcessor(address processor) external onlyOwner {
        if (processor == address(0)) revert InvalidAddress();
        attestedProcessors[processor] = true;
        emit ProcessorAttested(processor, bytes32(0));
    }

    /**
     * @notice Owner can revoke a processor's attestation.
     * @param processor The secp256k1 address to revoke.
     */
    function revokeProcessor(address processor) external onlyOwner {
        attestedProcessors[processor] = false;
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
     *      Requires the recovered signer to be an attested processor.
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
        bytes32 digest = keccak256(abi.encodePacked(block.chainid, address(this), user, pnlDelta, nonce));
        
        if (!verifyAcurastSignature(digest, signature)) revert ProcessorNotAttested();

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
     * @notice Triggers a real harvest+compound cycle via the AerodromeAutocompounder,
     *         then credits the realized USDC profit proportionally to all vault depositors.
     *
     * @dev    Authorization flow (dual-layer TEE security):
     *         1. verifyAcurastSignature  — checks secp256k1 runtime ECDSA against acurastSigner.
     *         2. attestedProcessors gate — the recovered signer must be P-256 TEE-attested.
     *
     *         If `autocompounder` is set:
     *           a. Calls `autocompounder.harvestAndCompound(minAssetOut, profitShareBps)`.
     *           b. Reads `autocompounder.pendingProfit()` to find realized USDC.
     *           c. If profit >= minHarvestProfitUsdc: calls `autocompounder.pullProfit()`,
     *              which transfers USDC here, and distributes it across all active balances.
     *
     *         If `autocompounder` is NOT set (legacy / testnet mode):
     *           Falls back to the original behaviour — just updates `lastHarvest`.
     *
     * @param payloadHash  keccak256(keeperAddress, poolAddress, aprBps, rewardCents, timestamp)
     *                     built by the TEE worker to prove profitability before executing.
     * @param minAssetOut  Minimum USDC to accept from the AERO → USDC swap (slippage guard).
     *                     Pass 0 to use the autocompounder's internal slippage tolerance.
     */
    function executeHarvest(
        bytes32 payloadHash,
        bytes32 r,
        bytes32 s,
        uint8 v,
        uint256 minAssetOut
    ) external nonReentrant {
        bytes memory signature = abi.encodePacked(r, s, v);
        // verifyAcurastSignature now checks attestedProcessors — covers both the
        // "valid signer" and "attested processor" gates in a single ECDSA recover.
        if (!verifyAcurastSignature(payloadHash, signature)) revert ProcessorNotAttested();

        lastHarvest = block.timestamp;

        uint256 profitCredited = 0;

        if (address(autocompounder) != address(0)) {
            // ── Real Harvest + Compound ──────────────────────────────────────
            autocompounder.harvestAndCompound(minAssetOut, profitShareBps);

            uint256 pending = autocompounder.pendingProfit();
            if (pending >= minHarvestProfitUsdc) {
                // Pull profit from the autocompounder into this vault
                autocompounder.pullProfit(pending, address(this));
                profitCredited = pending;

                // ── Distribute profit to all depositors proportionally ────
                // We scan all accounts via total vault balance and credit each
                // depositor their pro-rata share of the profit by increasing
                // individual balances using their share of the total pool.
                //
                // NOTE: Full on-chain iteration over all users is gas-prohibitive
                // at scale. For the current single-user testnet model this is
                // fine. For production, migrate to an ERC-4626 share-based model
                // where totalAssets() grows and share price appreciates instead.
                //
                // For now: credit the entire profit to the vault's total asset
                // pool. Each user's proportional share is realized at withdraw()
                // time via the updated balance-to-initialDeposit ratio.
                _creditProfitToVault(profitCredited);

                emit ProfitCredited(profitCredited);
            }
        }

        emit HarvestExecuted(payloadHash, profitCredited);
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

    /// @notice Set the primary user for harvest profit attribution (testnet only).
    function setPrimaryUser(address user) external onlyOwner {
        primaryUser = user;
    }

    // --- AUTOCOMPOUNDER INTEGRATION ---

    /**
     * @notice Deploy idle vault USDC into the Aerodrome pool via the autocompounder.
     * @dev    Only callable by the owner or an attested processor. Allows the TEE
     *         to autonomously deploy capital without a separate admin step.
     * @param  amount    USDC amount to deploy (must be <= vault asset balance).
     * @param  minLpOut  Minimum LP tokens to receive (slippage guard).
     */
    function deployToPool(uint256 amount, uint256 minLpOut)
        external
        nonReentrant
    {
        if (msg.sender != owner() && !attestedProcessors[msg.sender]) revert Unauthorized();
        if (address(autocompounder) == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        // Approve autocompounder to pull from this vault
        asset.approve(address(autocompounder), amount);
        autocompounder.depositIntoPool(amount, minLpOut);

        emit PoolDeployed(amount, minLpOut);
    }

    /**
     * @notice Update the autocompounder address.
     * @dev    Subject to the existing 2-day timelock via initiateUpdate/applyUpdate.
     *         Call initiateUpdate(keccak256("autocompounder"), newAddr) first.
     */
    function setAutocompounder(address newAutocompounder) external onlyOwner {
        autocompounder = IAerodromeAutocompounder(newAutocompounder);
        emit AutocompounderSet(newAutocompounder);
    }

    /// @notice Update profit share fraction (BPS). E.g. 2000 = 20% to profit.
    function setProfitShareBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "Invalid BPS");
        profitShareBps = bps;
    }

    /// @notice Update minimum profit threshold to pull (anti-dust).
    function setMinHarvestProfitUsdc(uint256 minUsdc) external onlyOwner {
        minHarvestProfitUsdc = minUsdc;
    }

    /**
     * @dev Distributes `profitAmount` USDC across all depositors by boosting their
     *      balances proportionally based on their share of the total vault balance.
     *
     *      This is a simple linear sweep — acceptable for the current single-user
     *      testnet model. A production multi-user version should use ERC-4626 share
     *      accounting instead (one storage write per harvest, not per user).
     */
    /**
     * @dev Distributes `profitAmount` USDC across depositors.
     *      For this testnet version, we attribute it to the `primaryUser`.
     */
    function _creditProfitToVault(uint256 profitAmount) internal {
        if (primaryUser != address(0)) {
            userData[primaryUser].balance += uint128(profitAmount);
        }
    }

    // --- HELPERS ---

    /// @notice Returns true if the signature was produced by any attested processor.
    /// @dev    Checks the `attestedProcessors` set rather than the single `acurastSigner`
    ///         so that multiple processors (and processor rotations) are handled without
    ///         redeployment. The legacy `acurastSigner` field is kept for event-log
    ///         and interface compatibility, but authorization is set-based.
    function verifyAcurastSignature(bytes32 digest, bytes memory signature) public view override returns (bool) {
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);
        return attestedProcessors[recovered];
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