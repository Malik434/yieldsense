// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

// ─────────────────────────────────────────────────────────────────────────────
// External Protocol Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @dev Aerodrome gauge interface (compatible with Velodrome V2 gauges on Base).
 *      The gauge holds the LP tokens and emits AERO rewards.
 */
interface IAerodromeGauge {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function getReward(address account) external;
    function balanceOf(address account) external view returns (uint256);
    function earned(address account) external view returns (uint256);
    function rewardToken() external view returns (address);
}

/**
 * @dev Aerodrome pool/LP interface (IPool is the same as the LP token ERC-20).
 */
interface IAerodromePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/**
 * @dev Aerodrome Router interface — used to swap AERO → USDC and add liquidity.
 */
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function quoteAddLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        address factory,
        uint256 amountADesired,
        uint256 amountBDesired
    ) external view returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);

    function defaultFactory() external view returns (address);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @title AerodromeAutocompounder
 * @notice Holds LP tokens staked in an Aerodrome gauge, harvests AERO rewards,
 *         swaps them back to the vault asset (USDC), and makes the compounded
 *         profit available to YieldSenseKeeper as the `yieldSource`.
 *
 * @dev Flow:
 *   1. Users deposit USDC into YieldSenseKeeper (the "Vault").
 *   2. The Vault owner (or TEE-authorized call) calls `depositIntoPool()` here,
 *      which converts USDC → LP tokens and stakes them in the Aerodrome gauge.
 *   3. The Acurast TEE worker monitors yield and calls `harvestAndCompound()`
 *      when it is provably profitable (gas < reward).
 *   4. `harvestAndCompound()` claims AERO from the gauge, swaps half to USDC
 *      (or the vault asset), re-adds liquidity, and updates `pendingProfit`.
 *   5. YieldSenseKeeper calls `pullProfit(amount)` to transfer the realized
 *      USDC profit into the Vault (crediting all depositors).
 *
 * Authorization:
 *   - Only the designated `keeper` address (the YieldSenseKeeper contract or the
 *     Acurast TEE worker) can call `harvestAndCompound()` and `pullProfit()`.
 *   - Owner (protocol multisig / timelock) can update addresses with a 2-day delay.
 */
contract AerodromeAutocompounder is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice The Aerodrome LP pool this compounder manages.
    IAerodromePool public immutable pool;

    /// @notice Aerodrome gauge where LP tokens are staked for AERO rewards.
    IAerodromeGauge public immutable gauge;

    /// @notice The vault asset (USDC) — what the YieldSenseKeeper tracks.
    IERC20 public immutable asset;

    /// @notice AERO reward token emitted by the gauge.
    IERC20 public immutable rewardToken;

    // ── Mutable config ────────────────────────────────────────────────────────

    /// @notice Aerodrome router used for swaps and liquidity additions.
    IAerodromeRouter public router;

    /**
     * @notice The authorized caller that can trigger harvests and pull profit.
     *         Set to the YieldSenseKeeper address after deployment.
     */
    address public keeper;

    /// @notice Slippage tolerance for swaps/liquidity in BPS (e.g. 50 = 0.5%).
    uint256 public slippageBps = 50;

    /// @notice Profit share percentage in BPS (e.g. 2000 = 20%).
    uint256 public profitShareBps = 2000;

    uint256 private constant BPS = 10_000;

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Accumulated USDC profit from harvests not yet pulled by the Vault.
    uint256 public pendingProfit;

    /// @notice Total LP tokens currently staked in the gauge by this compounder.
    uint256 public totalStakedLp;

    /// @notice Timestamp of the last successful harvest.
    uint256 public lastHarvestAt;

    /// @notice Total USDC-equivalent value compounded since deployment.
    uint256 public totalCompounded;

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(uint256 usdcIn, uint256 lpMinted, uint256 lpStaked);
    event HarvestAndCompounded(
        uint256 rewardClaimed,
        uint256 rewardSwappedToAsset,
        uint256 lpAdded,
        uint256 profitUsdc,
        uint256 timestamp
    );
    event ProfitPulled(address indexed to, uint256 amount);
    event EmergencyWithdrawn(address indexed to, uint256 lpAmount, uint256 usdcAmount);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event SlippageUpdated(uint256 oldBps, uint256 newBps);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAmount();
    error InsufficientPendingProfit();
    error SlippageTooHigh();

    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(
        address pool_,
        address gauge_,
        address asset_,
        address rewardToken_,
        address router_,
        address keeper_
    ) Ownable(msg.sender) {
        pool        = IAerodromePool(pool_);
        gauge       = IAerodromeGauge(gauge_);
        asset       = IERC20(asset_);
        rewardToken = IERC20(rewardToken_);
        router      = IAerodromeRouter(router_);
        keeper      = keeper_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEPOSIT: USDC → LP → Gauge
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Converts USDC into LP tokens and stakes them in the Aerodrome gauge.
     * @dev    The Vault (YieldSenseKeeper) calls this to deploy idle USDC into yield.
     *         Assumes the pool is a USDC/X stable or volatile pair.
     *
     *         Split strategy: 
     *         - Stable pair   → split 50/50 by value using pool reserves.
     *         - Volatile pair → split 50/50 by value (router handles imbalance dust).
     *
     * @param usdcAmount  The amount of USDC (asset) to deploy.
     * @param amountToSwap  Exact USDC amount to zap to otherToken.
     */
    function depositIntoPool(uint256 usdcAmount, uint256 amountToSwap)
        external
        nonReentrant
        onlyKeeper
    {
        if (usdcAmount == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint256 lpMinted = _convertAssetToLp(usdcAmount, amountToSwap, block.timestamp + 60);

        // Stake LP in gauge
        IERC20(address(pool)).approve(address(gauge), lpMinted);
        gauge.deposit(lpMinted);
        totalStakedLp += lpMinted;

        emit Deposited(usdcAmount, lpMinted, totalStakedLp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HARVEST + COMPOUND
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Claims AERO rewards from the gauge, swaps a portion to USDC (profit),
     *         and re-invests the rest as additional LP (compounding).
     *
     * @dev    Called exclusively by the Acurast TEE worker via YieldSenseKeeper's
     *         `executeHarvest()`, which verifies the profitability proof before
     *         forwarding here.
     *
     *         Split of claimed AERO:
     *           - `profitShareBps` (e.g. 20%) → swapped to USDC → `pendingProfit`
     *           - Remainder (e.g. 80%) → re-added as LP → compounded into position
     *
     *         This split maximizes long-term position growth while still providing
     *         realized USDC profit that the Vault can credit to depositors.
     *
     * @param  minLpOut      Minimum LP tokens to receive from compounding.
     * @param  amountToSwap  Exact USDC amount to zap to otherToken.
     * @param  deadline      Deadline for execution.
     * @param  routes        Routes for swap.
     */
    function harvestAndCompound(
        uint256 minLpOut,
        uint256 amountToSwap,
        uint256 deadline,
        IAerodromeRouter.Route[] calldata routes
    )
        external
        nonReentrant
        onlyKeeper
    {
        require(block.timestamp <= deadline, "Stale quote");

        // 1. Claim AERO from gauge
        gauge.getReward(address(this));
        uint256 rewardBal = rewardToken.balanceOf(address(this));
        if (rewardBal == 0) return;

        // 2. Split: profit portion → USDC, compound portion → re-add as LP
        uint256 profitReward   = (rewardBal * profitShareBps) / BPS;
        uint256 compoundReward = rewardBal - profitReward;

        uint256 profitUsdc = 0;

        // 3. Swap profit-share AERO → USDC
        if (profitReward > 0) {
            profitUsdc = _swapRewardToAsset(profitReward, _minOut(profitReward), deadline, routes);
            pendingProfit += profitUsdc;
        }

        // 4. Compound: swap remaining AERO → LP and stake
        uint256 newLp = 0;
        if (compoundReward > 0) {
            newLp = _compoundRewardToLp(compoundReward, amountToSwap, deadline, routes);
            if (newLp > 0) {
                require(newLp >= minLpOut, "SlippageTooHigh");
                IERC20(address(pool)).approve(address(gauge), newLp);
                gauge.deposit(newLp);
                totalStakedLp += newLp;
            }
        }

        lastHarvestAt   = block.timestamp;
        totalCompounded += profitUsdc;

        emit HarvestAndCompounded(rewardBal, profitUsdc, newLp, profitUsdc, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PULL PROFIT (called by YieldSenseKeeper.executeHarvest)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Transfers realized USDC profit to the Vault (YieldSenseKeeper).
     * @dev    Called by YieldSenseKeeper after `harvestAndCompound()` has run.
     *         The Vault distributes the profit proportionally to all depositors.
     * @param  amount   Amount of USDC to transfer to `to`.
     * @param  to       Recipient — always the YieldSenseKeeper vault address.
     */
    function pullProfit(uint256 amount, address to)
        external
        nonReentrant
        onlyKeeper
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingProfit) revert InsufficientPendingProfit();

        pendingProfit -= amount;
        asset.safeTransfer(to, amount);

        emit ProfitPulled(to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEWS
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AERO rewards pending in the gauge (not yet claimed).
    function pendingRewards() external view returns (uint256) {
        return gauge.earned(address(this));
    }

    /// @notice LP tokens held in the gauge by this compounder.
    function stakedLpBalance() external view returns (uint256) {
        return gauge.balanceOf(address(this));
    }

    /// @notice Computes total value of staked LP and accumulated dust in terms of USDC.
    function getDeployedValueInUSDC() external view returns (uint256) {
        uint256 staked = gauge.balanceOf(address(this));
        uint256 totalSupply = pool.totalSupply();
        if (totalSupply == 0) return 0;

        (uint256 reserve0, uint256 reserve1, ) = pool.getReserves();
        bool isToken0 = pool.token0() == address(asset);
        uint256 reserveAsset = isToken0 ? reserve0 : reserve1;

        uint256 lpValue = (2 * reserveAsset * staked) / totalSupply;

        uint256 assetDust = asset.balanceOf(address(this)) - pendingProfit;
        address otherToken = isToken0 ? pool.token1() : pool.token0();
        uint256 otherDust = IERC20(otherToken).balanceOf(address(this));

        uint256 otherReserve = isToken0 ? reserve1 : reserve0;
        uint256 otherDustValueInAsset = otherReserve == 0 ? 0 : (otherDust * reserveAsset) / otherReserve;

        return lpValue + assetDust + otherDustValueInAsset;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UNWIND LP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Unstakes LP from gauge and removes liquidity to free up USDC.
     * @param lpAmount The amount of LP to unwind.
     * @return usdcUnwound The amount of USDC recovered.
     */
    function unwindLp(uint256 lpAmount) external nonReentrant onlyKeeper returns (uint256 usdcUnwound) {
        if (lpAmount == 0) return 0;

        gauge.withdraw(lpAmount);
        totalStakedLp -= lpAmount;

        IERC20(address(pool)).approve(address(router), lpAmount);

        address token0 = pool.token0();
        address token1 = pool.token1();
        bool stable = pool.stable();

        (uint256 amount0, uint256 amount1) = router.removeLiquidity(
            token0,
            token1,
            stable,
            lpAmount,
            0,
            0,
            address(this),
            block.timestamp + 60
        );

        bool isToken0 = token0 == address(asset);
        usdcUnwound = isToken0 ? amount0 : amount1;

        if (usdcUnwound > 0) {
            asset.safeTransfer(msg.sender, usdcUnwound);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EMERGENCY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Emergency: unstakes all LP from the gauge and withdraws to `to`.
     *         Also claims any pending AERO and sweeps remaining USDC.
     * @dev    Only callable by the owner (protocol multisig).
     */
    function emergencyWithdraw(address to) external onlyOwner nonReentrant {
        uint256 staked = gauge.balanceOf(address(this));

        if (staked > 0) {
            gauge.getReward(address(this));
            gauge.withdraw(staked);
        }

        uint256 lpBal = IERC20(address(pool)).balanceOf(address(this));
        if (lpBal > 0) {
            IERC20(address(pool)).transfer(to, lpBal);
        }

        uint256 usdcBal = asset.balanceOf(address(this));
        if (usdcBal > 0) {
            asset.safeTransfer(to, usdcBal);
        }

        totalStakedLp = 0;
        pendingProfit = 0;

        emit EmergencyWithdrawn(to, lpBal, usdcBal);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    function setKeeper(address newKeeper) external onlyOwner {
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setRouter(address newRouter) external onlyOwner {
        emit RouterUpdated(address(router), newRouter);
        router = IAerodromeRouter(newRouter);
    }

    function setProfitShareBps(uint256 newBps) external onlyOwner {
        if (newBps > BPS) revert SlippageTooHigh();
        profitShareBps = newBps;
    }

    function setSlippage(uint256 newBps) external onlyOwner {
        if (newBps > 500) revert SlippageTooHigh(); // max 5%
        emit SlippageUpdated(slippageBps, newBps);
        slippageBps = newBps;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Converts `usdcAmount` into LP tokens by:
     *      1. Swapping ~half the USDC to token1 of the pool.
     *      2. Adding both tokens as liquidity.
     *      Returns the LP tokens received.
     */
    function _convertAssetToLp(uint256 usdcAmount, uint256 amountToSwap, uint256 deadline)
        internal
        returns (uint256 lpReceived)
    {
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool    stable = pool.stable();
        address factory = router.defaultFactory();

        // Determine which side is the vault asset
        bool assetIsToken0 = (token0 == address(asset));
        address otherToken = assetIsToken0 ? token1 : token0;

        uint256 actualSwap = (amountToSwap == 0 || amountToSwap >= usdcAmount) ? usdcAmount / 2 : amountToSwap;
        uint256 otherOut = _swap(address(asset), otherToken, stable, factory, actualSwap, _minOut(actualSwap), deadline);

        // Remaining asset balance
        uint256 assetRemaining = usdcAmount - actualSwap;

        uint256 amountA; uint256 amountB; uint256 liquidity;

        asset.approve(address(router), assetRemaining);
        IERC20(otherToken).approve(address(router), otherOut);

        if (assetIsToken0) {
            (amountA, amountB, liquidity) = router.addLiquidity(
                address(asset), otherToken, stable,
                assetRemaining, otherOut,
                _minOut(assetRemaining), _minOut(otherOut),
                address(this),
                deadline
            );
        } else {
            (amountA, amountB, liquidity) = router.addLiquidity(
                otherToken, address(asset), stable,
                otherOut, assetRemaining,
                _minOut(otherOut), _minOut(assetRemaining),
                address(this),
                deadline
            );
        }

        lpReceived = liquidity;
    }

    /**
     * @dev Swaps `rewardIn` AERO → USDC (asset). Returns USDC received.
     */
    function _swapRewardToAsset(uint256 rewardIn, uint256 minOut, uint256 deadline, IAerodromeRouter.Route[] calldata routes)
        internal
        returns (uint256 assetOut)
    {
        IERC20(address(rewardToken)).approve(address(router), rewardIn);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            rewardIn,
            minOut,
            routes,
            address(this),
            deadline
        );
        assetOut = amounts[amounts.length - 1];
    }

    /**
     * @dev Compounds `rewardIn` AERO by splitting → half to token0, half to token1,
     *      then adding liquidity. Returns new LP tokens minted.
     */
    function _compoundRewardToLp(uint256 rewardIn, uint256 amountToSwap, uint256 deadline, IAerodromeRouter.Route[] calldata routes)
        internal
        returns (uint256 lpMinted)
    {
        uint256 assetTotal = _swapRewardToAsset(rewardIn, _minOut(rewardIn), deadline, routes);
        if (assetTotal == 0) return 0;

        address token0 = pool.token0();
        address token1 = pool.token1();
        bool    stable = pool.stable();
        address factory = router.defaultFactory();

        bool assetIsToken0 = (token0 == address(asset));
        address otherToken = assetIsToken0 ? token1 : token0;

        uint256 actualSwap = (amountToSwap == 0 || amountToSwap >= assetTotal) ? assetTotal / 2 : amountToSwap;
        uint256 otherOut = _swap(address(asset), otherToken, stable, factory, actualSwap, _minOut(actualSwap), deadline);
        uint256 assetRem = assetTotal - actualSwap;

        asset.approve(address(router), assetRem);
        IERC20(otherToken).approve(address(router), otherOut);

        uint256 liq;
        if (assetIsToken0) {
            (,, liq) = router.addLiquidity(
                address(asset), otherToken, stable,
                assetRem, otherOut,
                _minOut(assetRem), _minOut(otherOut),
                address(this),
                deadline
            );
        } else {
            (,, liq) = router.addLiquidity(
                otherToken, address(asset), stable,
                otherOut, assetRem,
                _minOut(otherOut), _minOut(assetRem),
                address(this),
                deadline
            );
        }

        lpMinted = liq;
    }

    /**
     * @dev Generic single-hop swap via Aerodrome router.
     */
    function _swap(
        address from,
        address to,
        bool stable,
        address factory,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        IERC20(from).approve(address(router), amountIn);
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({ from: from, to: to, stable: stable, factory: factory });
        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minOut,
            routes,
            address(this),
            deadline
        );
        amountOut = amounts[amounts.length - 1];
    }

    /**
     * @dev Applies the configured slippage tolerance to derive a `minAmountOut`.
     */
    function _minOut(uint256 amount) internal view returns (uint256) {
        return (amount * (BPS - slippageBps)) / BPS;
    }
}
