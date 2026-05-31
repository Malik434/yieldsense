// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {
    ERC4626
} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

struct Route {
    address from;
    address to;
    bool stable;
    address factory;
}

interface IAerodromeAutocompounder {
    function harvestAndCompound(
        uint256 minLpOut,
        uint256 amountToSwap,
        uint256 deadline,
        Route[] calldata routes
    ) external;
    function pullProfit(uint256 amount) external;
    function depositIntoPool(
        uint256 usdcAmount,
        uint256 amountToSwap,
        uint256 minLpOut
    ) external;
    function pendingProfit() external view returns (uint256);
    function getDeployedValueInUSDC() external view returns (uint256);
    function unwindLp(uint256 lpAmount) external returns (uint256 usdcUnwound);
    function pool() external view returns (address);
    function factory() external view returns (address);
    function asset() external view returns (address);
    function rewardToken() external view returns (address);
    function keeper() external view returns (address);
    function router() external view returns (address);
    function maxTotalAssets() external view returns (uint256);
    function slippageBps() external view returns (uint256);
    function stakedLpBalance() external view returns (uint256);
}

interface IExecutorRegistry {
    function isAuthorized(
        address processor,
        bytes32 role
    ) external view returns (bool);
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

    bytes32 public constant YIELD_EXECUTOR = keccak256("YIELD_EXECUTOR");
    bytes32 public constant GRID_EXECUTOR = keccak256("GRID_EXECUTOR");
    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TIMELOCK_DELAY = 2 days;
    uint256 public constant MIN_HARVEST_INTERVAL = 45 minutes;
    uint256 public constant MAX_DEADLINE_WINDOW = 10 minutes;

    struct PendingAddress {
        address value;
        uint64 effectiveTime;
    }

    address public feeRecipient;
    address public yieldSource;
    address public counterparty;

    IAerodromeAutocompounder public autocompounder;
    IExecutorRegistry public executorRegistry;
    uint256 public minHarvestProfitUsdc = 1e6;

    /// @notice On-chain deposit cap. Defaults to 0 (deposits disabled) until explicitly set.
    uint256 public maxTotalAssets;

    /// @notice Allowlisted tokens that may appear in harvest routes.
    mapping(address => bool) public allowedRouteToken;

    /// @notice Allowlisted factories that may appear in harvest routes.
    mapping(address => bool) public allowedRouteFactory;

    mapping(address => bool) public attestedProcessors;
    /// @notice Maps a user address to their provisioned Acurast processor.
    mapping(address => address) public userProcessors;

    mapping(address => uint256) public lastDepositBlock;

    mapping(bytes32 => PendingAddress) public pendingUpdates;
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;
    mapping(uint256 => bool) public usedHarvestNonces;

    uint256 public lastHarvest;

    /**
     * @notice Records a TEE-signed trade proof on-chain for auditability.
     * @dev pnlDelta is in 6-decimal precision (USDC units).
     */
    event TradeExecuted(
        address indexed user,
        int256 pnlDelta,
        uint256 nonce,
        bytes32 indexed digest
    );
    event HarvestExecuted(
        address indexed processor,
        uint256 indexed nonce,
        uint256 profitCredited
    );
    event PoolDeployed(uint256 usdcAmount, uint256 minLpOut);
    event UpdateInitiated(
        bytes32 indexed key,
        address indexed newValue,
        uint256 effectiveTime
    );
    event UpdateApplied(bytes32 indexed key, address indexed newValue);
    event ProcessorAttested(address indexed processor, bytes32 certHash);
    event ProcessorAssigned(address indexed user, address indexed processor);
    event AutocompounderSet(address indexed autocompounder);
    event ProfitCredited(uint256 amount);
    event LiquidityUnwoundForWithdrawal(
        uint256 requestedAssets,
        uint256 lpUnwound,
        uint256 assetsRecovered
    );
    event MaxTotalAssetsUpdated(uint256 oldCap, uint256 newCap);
    event RouteTokenAllowlisted(address indexed token, bool allowed);
    event RouteFactoryAllowlisted(address indexed factory, bool allowed);
    event ProcessorRevoked(address indexed processor);
    event ExecutorRegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    error Unauthorized();
    error InvalidAddress();
    error AmountZero();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InsufficientBalance();
    error TimelockNotExpired();
    error NoUpdatePending();
    error ProcessorNotAttested();
    error ProcessorNotAssignedToUser();
    error UnauthorizedExecutor();
    error HarvestTooFrequent();
    error NoProfitReceived();
    error DepositCapExceeded();
    error InvalidRoute();
    error InvalidRoutePool();
    error InvalidRouteStart();
    error InvalidRouteEnd();
    error InvalidRouteContinuity();
    error InvalidRouteFactory();
    error InvalidRouteToken();

    modifier onlyOwnerOrYieldExecutor() {
        if (msg.sender != owner() && !_isYieldExecutor(msg.sender)) {
            revert UnauthorizedExecutor();
        }
        _;
    }

    constructor(
        address _asset,
        address _yieldSource,
        address _counterparty,
        address _autocompounder,
        address _executorRegistry
    )
        ERC4626(IERC20(_asset))
        ERC20("YieldSense Vault", "ysUSDC")
        Ownable(msg.sender)
    {
        if (
            _asset == address(0) ||
            _yieldSource == address(0) ||
            _counterparty == address(0) ||
            _executorRegistry == address(0)
        ) revert InvalidAddress();
        feeRecipient = msg.sender;
        yieldSource = _yieldSource;
        counterparty = _counterparty;
        executorRegistry = IExecutorRegistry(_executorRegistry);
        // maxTotalAssets starts at 0 — deposits are DISABLED until the Safe
        // explicitly calls setMaxTotalAssets() after accepting ownership.
        maxTotalAssets = 0;
        if (_autocompounder != address(0)) {
            autocompounder = IAerodromeAutocompounder(_autocompounder);
            // Seed route allowlists from the configured autocompounder
            allowedRouteFactory[
                IAerodromeAutocompounder(_autocompounder).factory()
            ] = true;
            allowedRouteToken[_asset] = true;
            allowedRouteToken[_yieldSource] = true;
        }
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Sets the on-chain deposit cap.
     * @dev    Must be called by the Safe AFTER it has accepted ownership.
     *         Set to 10e6–100e6 for smoke test, 500e6–1000e6 for capped pilot.
     */
    function setMaxTotalAssets(uint256 newCap) external onlyOwner {
        emit MaxTotalAssetsUpdated(maxTotalAssets, newCap);
        maxTotalAssets = newCap;
    }

    /// @notice Adds or removes a token from the harvest route allowlist.
    function setAllowedRouteToken(
        address token,
        bool allowed
    ) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        allowedRouteToken[token] = allowed;
        emit RouteTokenAllowlisted(token, allowed);
    }

    /// @notice Adds or removes a factory from the harvest route allowlist.
    function setAllowedRouteFactory(
        address factory_,
        bool allowed
    ) external onlyOwner {
        if (factory_ == address(0)) revert InvalidAddress();
        allowedRouteFactory[factory_] = allowed;
        emit RouteFactoryAllowlisted(factory_, allowed);
    }

    // ─── USER PROCESSOR MAPPING ───────────────────────────────────────────────

    /**
     * @notice Legacy compatibility hook for older frontend flows.
     * @dev Production execution no longer depends on per-user processor binding.
     *      Grid processor authorization is validated through executorRegistry.
     * @param processor The secp256k1 Ethereum address of the Acurast processor.
     */
    function assignProcessor(address processor) external {
        if (processor == address(0)) revert InvalidAddress();
        if (!_isGridExecutor(processor)) revert UnauthorizedExecutor();
        userProcessors[msg.sender] = processor;
        emit ProcessorAssigned(msg.sender, processor);
    }

    // ─── P-256 TEE ATTESTATION ────────────────────────────────────────────────

    /**
     * @notice Sets the Acurast P-256 certificate authority public key.
     * @dev    DISABLED for MVP. Re-enabled in v2 once Acurast confirms cert format.
     *         Do NOT call setAttestationRoot on mainnet until the cert-to-address
     *         binding is verified against Acurast's published certificate structure.
     *         Processor authorization is currently managed by ExecutorRegistry.
     */
    function setAttestationRoot(bytes32, bytes32) external pure {
        revert("P256 attestation root disabled for MVP");
    }

    /**
     * @notice Permissionless P-256 TEE attestation.
     * @dev    DISABLED for MVP. Acurast's signing domain (acusig+SCRIPT_HASH+message)
     *         is incompatible with standard EIP-712 recovery. Use ExecutorRegistry
     *         registration for processor authorization.
     */
    function attestProcessor(address, bytes32, bytes32, bytes32) external pure {
        revert(
            "Permissionless attestation disabled for MVP. Use ExecutorRegistry."
        );
    }

    /** @dev See {IERC4626-totalAssets}. */
    // function totalAssets() public view virtual override returns (uint256) {
    //     uint256 keeperBal = IERC20(asset()).balanceOf(address(this));
    //     uint256 strategyBal = address(autocompounder) != address(0)
    //         ? autocompounder.getDeployedValueInUSDC()
    //         : 0;
    //     return keeperBal + strategyBal;
    // }

    /** @dev See {IERC4626-maxDeposit}. */
    function maxDeposit(
        address
    ) public view virtual override returns (uint256) {
        if (paused()) return 0;
        uint256 total = totalAssets();
        if (total >= maxTotalAssets) return 0;
        return maxTotalAssets - total;
    }

    /** @dev See {IERC4626-maxMint}. */
    function maxMint(address) public view virtual override returns (uint256) {
        if (paused()) return 0;
        uint256 total = totalAssets();
        if (total >= maxTotalAssets) return 0;
        // Approximation: since 1 share = 1 asset at start, we use maxAssets-total.
        // For accurate mint limits, we'd use previewMint, but this is safe for pilot.
        uint256 remainingAssets = maxTotalAssets - total;
        return convertToShares(remainingAssets);
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
        if (block.timestamp < pending.effectiveTime)
            revert TimelockNotExpired();

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

        bytes32 digest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                user,
                pnlDelta,
                nonce
            )
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);

        if (!_isGridExecutor(recovered)) revert UnauthorizedExecutor();

        emit TradeExecuted(user, pnlDelta, nonce, digest);
    }

    /**
     * @notice Triggers a harvest+compound cycle. Only callable by a registered yield executor.
     *
     * Auth model: msg.sender must be authorized as YIELD_EXECUTOR in ExecutorRegistry.
     * The Acurast TEE submits this transaction directly via
     * _STD_.chains.ethereum.fulfill(), so msg.sender is the processor's on-chain
     * Ethereum address for that deployment.
     *
     * The EIP-712 signature flow has been removed. Acurast's signing domain
     * ("acusig" + SCRIPT_HASH + message) is incompatible with EIP-712 recovery.
     *
     * @param nonce        Unique harvest nonce to prevent replay.
     * @param targetPool   Target Aerodrome pool address.
     * @param minLpOut     Minimum LP tokens to accept from compounding.
     * @param amountToSwap Precise amount of USDC to swap (TEE-calculated zap).
     * @param deadline     Maximum block timestamp for execution.
     * @param routes       Route path for Aerodrome swaps.
     */
    function executeHarvest(
        uint256 nonce,
        address targetPool,
        uint256 minLpOut,
        uint256 amountToSwap,
        uint256 deadline,
        Route[] calldata routes
    ) external nonReentrant whenNotPaused {
        // Auth: only yield-executor processors registered in the ExecutorRegistry
        // may call this. Acurast deployment addresses are intentionally not
        // stored directly in this vault's execution checks.
        if (!_isYieldExecutor(msg.sender)) revert UnauthorizedExecutor();

        // Guard: autocompounder must be configured
        if (address(autocompounder) == address(0)) revert InvalidAddress();

        if (usedHarvestNonces[nonce]) revert NonceAlreadyUsed();
        usedHarvestNonces[nonce] = true;

        require(
            deadline <= block.timestamp + MAX_DEADLINE_WINDOW,
            "Deadline too far in future"
        );
        require(block.timestamp <= deadline, "Stale quote");
        require(routes.length > 0, "Empty routes");
        if (block.timestamp < lastHarvest + MIN_HARVEST_INTERVAL)
            revert HarvestTooFrequent();

        // Validate harvest routes against the configured strategy
        _validateHarvestRoutes(targetPool, routes);

        // Execute harvest — lastHarvest is set AFTER compound succeeds
        autocompounder.harvestAndCompound(
            minLpOut,
            amountToSwap,
            deadline,
            routes
        );
        lastHarvest = block.timestamp;

        uint256 profitCredited = 0;

        uint256 pending = autocompounder.pendingProfit();
        if (pending >= minHarvestProfitUsdc) {
            uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));
            autocompounder.pullProfit(pending);
            uint256 actualProfit = IERC20(asset()).balanceOf(address(this)) -
                balanceBefore;

            if (actualProfit == 0) revert NoProfitReceived();
            profitCredited = actualProfit;

            // Performance fee: mint shares to feeRecipient backed by the fee portion
            uint256 perfFee = (profitCredited * PERFORMANCE_FEE_BPS) /
                BPS_DENOMINATOR;
            if (perfFee > 0) {
                uint256 feeShares = previewDeposit(perfFee);
                _mint(feeRecipient, feeShares);
            }

            emit ProfitCredited(profitCredited);
        }

        emit HarvestExecuted(msg.sender, nonce, profitCredited);
    }

    /**
     * @notice Deploys idle vault assets into the yield-bearing pool.
     * @param amount       USDC to deploy.
     * @param amountToSwap Exact USDC to swap to the other pool token (TEE-calculated).
     * @param minLpOut     Minimum LP tokens to receive. MUST be non-zero on mainnet.
     */
    function deployToPool(
        uint256 amount,
        uint256 amountToSwap,
        uint256 minLpOut
    ) external nonReentrant whenNotPaused onlyOwnerOrYieldExecutor {
        if (address(autocompounder) == address(0)) revert InvalidAddress();
        if (amount == 0) revert AmountZero();
        if (minLpOut == 0) revert AmountZero();

        IERC20(asset()).forceApprove(address(autocompounder), amount);
        autocompounder.depositIntoPool(amount, amountToSwap, minLpOut);

        emit PoolDeployed(amount, minLpOut);
    }

    /**
     * @notice Unwinds LP tokens from the autocompounder back to USDC to service withdrawals.
     */
    function withdrawFromPool(
        uint256 lpAmount
    ) external nonReentrant onlyOwner {
        if (address(autocompounder) == address(0)) revert InvalidAddress();
        autocompounder.unwindLp(lpAmount);
    }

    function setAutocompounder(address newAutocompounder) external onlyOwner {
        if (newAutocompounder == address(0)) revert InvalidAddress();
        IAerodromeAutocompounder ac = IAerodromeAutocompounder(
            newAutocompounder
        );
        // Validate the new autocompounder matches this vault's asset and yield source
        if (ac.asset() != asset()) revert InvalidAddress();
        if (ac.rewardToken() != yieldSource) revert InvalidAddress();
        autocompounder = ac;
        // Re-seed route allowlists for the new strategy
        allowedRouteFactory[ac.factory()] = true;
        allowedRouteToken[asset()] = true;
        allowedRouteToken[yieldSource] = true;
        emit AutocompounderSet(newAutocompounder);
    }

    function setExecutorRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert InvalidAddress();
        address oldRegistry = address(executorRegistry);
        executorRegistry = IExecutorRegistry(newRegistry);
        emit ExecutorRegistryUpdated(oldRegistry, newRegistry);
    }

    function setMinHarvestProfitUsdc(uint256 minUsdc) external onlyOwner {
        minHarvestProfitUsdc = minUsdc;
    }

    // ─── ERC-4626 OVERRIDES ───────────────────────────────────────────────────

    /**
     * @notice Overrides ERC4626 totalAssets to include funds deployed in the autocompounder.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
        uint256 deployedValue = 0;

        if (address(autocompounder) != address(0)) {
            deployedValue = autocompounder.getDeployedValueInUSDC();
        }

        return vaultBalance + deployedValue;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        return super.maxWithdraw(owner);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        return super.maxRedeem(owner);
    }

    /**
     * @notice Enforce pause and flash loan block protection on standard ERC-4626 deposit/withdraw.
     */
    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused returns (uint256) {
        if (totalAssets() + assets > maxTotalAssets)
            revert DepositCapExceeded();
        lastDepositBlock[receiver] = block.number;
        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override whenNotPaused returns (uint256) {
        uint256 assets = previewMint(shares);
        if (totalAssets() + assets > maxTotalAssets)
            revert DepositCapExceeded();
        lastDepositBlock[receiver] = block.number;
        return super.mint(shares, receiver);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner_
    ) public override whenNotPaused returns (uint256) {
        require(
            block.number > lastDepositBlock[owner_],
            "Same block redemption not allowed"
        );
        _ensureWithdrawalLiquidity(assets);
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner_
    ) public override whenNotPaused returns (uint256) {
        require(
            block.number > lastDepositBlock[owner_],
            "Same block redemption not allowed"
        );
        _ensureWithdrawalLiquidity(previewRedeem(shares));
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

    function ownerAttestProcessor(address processor) external onlyOwner {
        if (processor == address(0)) revert InvalidAddress();
        attestedProcessors[processor] = true;
        emit ProcessorAttested(processor, bytes32(0));
    }

    /**
     * @notice Batch attest multiple Acurast processors in a single Safe transaction.
     */
    function ownerAttestProcessors(
        address[] calldata processors
    ) external onlyOwner {
        for (uint256 i = 0; i < processors.length; i++) {
            if (processors[i] == address(0)) revert InvalidAddress();
            attestedProcessors[processors[i]] = true;
            emit ProcessorAttested(processors[i], bytes32(0));
        }
    }

    function ownerRevokeProcessor(address processor) external onlyOwner {
        if (processor == address(0)) revert InvalidAddress();
        attestedProcessors[processor] = false;
        emit ProcessorRevoked(processor);
    }

    /**
     * @notice Batch revoke multiple Acurast processors in a single Safe transaction.
     */
    function ownerRevokeProcessors(
        address[] calldata processors
    ) external onlyOwner {
        for (uint256 i = 0; i < processors.length; i++) {
            if (processors[i] == address(0)) revert InvalidAddress();
            attestedProcessors[processors[i]] = false;
            emit ProcessorRevoked(processors[i]);
        }
    }

    function _isYieldExecutor(address processor) internal view returns (bool) {
        return executorRegistry.isAuthorized(processor, YIELD_EXECUTOR);
    }

    function _isGridExecutor(address processor) internal view returns (bool) {
        return executorRegistry.isAuthorized(processor, GRID_EXECUTOR);
    }

    function _ensureWithdrawalLiquidity(uint256 assets) internal {
        uint256 idleAssets = IERC20(asset()).balanceOf(address(this));
        if (idleAssets >= assets) return;

        if (address(autocompounder) == address(0)) revert InsufficientBalance();

        uint256 shortfall = assets - idleAssets;
        uint256 deployedValue = autocompounder.getDeployedValueInUSDC();
        uint256 stakedLp = autocompounder.stakedLpBalance();

        if (deployedValue == 0 || stakedLp == 0) revert InsufficientBalance();

        uint256 lpToUnwind = (shortfall * stakedLp + deployedValue - 1) /
            deployedValue;
        if (lpToUnwind > stakedLp) lpToUnwind = stakedLp;

        uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));
        autocompounder.unwindLp(lpToUnwind);
        uint256 recovered = IERC20(asset()).balanceOf(address(this)) -
            balanceBefore;

        if (IERC20(asset()).balanceOf(address(this)) < assets) {
            revert InsufficientBalance();
        }

        emit LiquidityUnwoundForWithdrawal(
            assets,
            lpToUnwind,
            recovered
        );
    }

    /**
     * @notice Validates harvest routes against the configured strategy.
     *         Enforces: correct pool, correct start/end tokens, route continuity,
     *         allowlisted factory, and allowlisted tokens.
     */
    function _validateHarvestRoutes(
        address targetPool,
        Route[] calldata routes
    ) internal view {
        if (address(autocompounder) == address(0)) revert InvalidAddress();

        // Pool must match the configured Aerodrome strategy pool
        if (targetPool == address(0)) revert InvalidRoutePool();
        if (targetPool != autocompounder.pool()) revert InvalidRoutePool();

        // Routes must start with the yield source (AERO)
        if (routes[0].from != yieldSource) revert InvalidRouteStart();

        // Routes must end with the vault asset (USDC)
        if (routes[routes.length - 1].to != asset()) revert InvalidRouteEnd();

        for (uint256 i = 0; i < routes.length; i++) {
            // Each factory must be allowlisted
            if (!allowedRouteFactory[routes[i].factory])
                revert InvalidRouteFactory();

            // Each token in the route must be allowlisted
            if (!allowedRouteToken[routes[i].from]) revert InvalidRouteToken();
            if (!allowedRouteToken[routes[i].to]) revert InvalidRouteToken();

            // Continuity: each route hop must start where the previous ended
            if (i > 0 && routes[i].from != routes[i - 1].to)
                revert InvalidRouteContinuity();
        }
    }
}
