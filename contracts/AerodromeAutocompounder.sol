// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";


// ─────────────────────────────────────────────────────────────────────────────
// External Protocol Interfaces
// ─────────────────────────────────────────────────────────────────────────────

interface IAerodromeGauge {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function getReward(address account) external;
    function balanceOf(address account) external view returns (uint256);
    function earned(address account) external view returns (uint256);
    function rewardToken() external view returns (address);
}

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
    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @title AerodromeAutocompounder
 * @notice Holds LP tokens staked in an Aerodrome gauge, harvests AERO rewards,
 *         swaps them back to the vault asset (USDC), and makes the compounded
 *         profit available to YieldSenseKeeper as the `yieldSource`.
 *
 * Trust Model:
 *   - The `keeper` MUST be the YieldSenseKeeper contract. The Acurast TEE
 *     calls YieldSenseKeeper, which in turn calls this contract.
 *   - The `router` is immutable for v1 to eliminate router-swap attack surface.
 *   - `pullProfit` and `emergencyWithdraw` always send funds to `keeper` (the
 *     vault) to preserve accounting and prevent admin sweeps to arbitrary addresses.
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

    /// @notice Aerodrome pool factory address (immutable).
    address public immutable factory;

    /// @notice Aerodrome router — immutable for v1 to eliminate router-swap surface.
    IAerodromeRouter public immutable router;

    // ── Mutable config ────────────────────────────────────────────────────────

    /**
     * @notice The YieldSenseKeeper contract address.
     *         MUST always be the vault contract — not an EOA or TEE worker.
     *         Set to the YieldSenseKeeper address immediately after deployment.
     */
    address public keeper;

    /// @notice Slippage tolerance for swaps/liquidity in BPS (e.g. 100 = 1%).
    uint256 public slippageBps = 100; // 1% default — conservative for production

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
    event SlippageUpdated(uint256 oldBps, uint256 newBps);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientPendingProfit();
    error SlippageTooHigh();
    error MinLpOutNotMet();

    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Only the YieldSenseKeeper vault contract may call these functions.
    modifier onlyKeeper() {
        if (msg.sender != keeper) revert Unauthorized();
        _;
    }

    /// @dev Keeper or owner may call — for emergency unwind fallback.
    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(
        address pool_,
        address gauge_,
        address asset_,
        address rewardToken_,
        address router_,
        address factory_,
        address keeper_
    ) Ownable(msg.sender) {
        pool        = IAerodromePool(pool_);
        gauge       = IAerodromeGauge(gauge_);
        asset       = IERC20(asset_);
        rewardToken = IERC20(rewardToken_);
        router      = IAerodromeRouter(router_);
        factory     = factory_;
        keeper      = keeper_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEPOSIT: USDC → LP → Gauge
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Converts USDC into LP tokens and stakes them in the Aerodrome gauge.
     * @dev    Only callable by the YieldSenseKeeper (keeper). NOT callable by owner
     *         or Acurast TEE directly.
     * @param usdcAmount   The amount of USDC (asset) to deploy.
     * @param amountToSwap Exact USDC amount to zap to otherToken.
     * @param minLpOut     Minimum LP tokens to receive — MUST be non-zero on mainnet.
     */
    function depositIntoPool(uint256 usdcAmount, uint256 amountToSwap, uint256 minLpOut)
        external
        nonReentrant
        onlyKeeper
    {
        if (usdcAmount == 0) revert ZeroAmount();
        if (minLpOut == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint256 lpMinted = _convertAssetToLp(usdcAmount, amountToSwap, block.timestamp + 60);

        if (lpMinted < minLpOut) revert MinLpOutNotMet();

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
            profitUsdc = _swapRewardToAsset(profitReward, deadline, routes);
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
     * @notice Transfers realized USDC profit to the YieldSenseKeeper vault.
     * @dev    Recipient is always `keeper` (the vault). Cannot be redirected.
     * @param  amount   Amount of USDC to transfer to the vault.
     */
    function pullProfit(uint256 amount)
        external
        nonReentrant
        onlyKeeper
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingProfit) revert InsufficientPendingProfit();

        pendingProfit -= amount;
        asset.safeTransfer(keeper, amount);

        emit ProfitPulled(keeper, amount);
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
        if (address(gauge) == address(0) || address(pool) == address(0)) return 0;
        
        uint256 staked = totalStakedLp;
        
        uint256 totalSupply;
        try pool.totalSupply() returns (uint256 ts) {
            totalSupply = ts;
        } catch {
            return 0;
        }
        
        if (totalSupply == 0) return 0;

        (uint256 reserve0, uint256 reserve1, ) = pool.getReserves();
        address t0 = pool.token0();
        bool isToken0 = t0 == address(asset);
        uint256 reserveAsset = isToken0 ? reserve0 : reserve1;

        uint256 lpValue = (2 * reserveAsset * staked) / totalSupply;

        uint256 assetDust = 0;
        if (address(asset) != address(0)) {
            uint256 bal = asset.balanceOf(address(this));
            assetDust = bal > pendingProfit ? bal - pendingProfit : 0;
        }

        address otherToken = isToken0 ? pool.token1() : t0;
        uint256 otherDust = (otherToken == address(0)) ? 0 : IERC20(otherToken).balanceOf(address(this));

        uint256 otherReserve = isToken0 ? reserve1 : reserve0;
        uint256 otherDustValueInAsset = (otherReserve == 0) ? 0 : (otherDust * reserveAsset) / otherReserve;

        return lpValue + assetDust + otherDustValueInAsset;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UNWIND LP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Unstakes LP from gauge, removes liquidity, and returns USDC to caller.
     * @dev    Callable by keeper (vault) OR owner (multisig emergency fallback).
     * @param lpAmount The amount of LP to unwind.
     * @return usdcUnwound The total amount of USDC recovered.
     */
    function unwindLp(uint256 lpAmount) external nonReentrant onlyKeeperOrOwner returns (uint256 usdcUnwound) {
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

        address otherToken = isToken0 ? token1 : token0;
        uint256 otherAmount = isToken0 ? amount1 : amount0;

        if (otherAmount > 0) {
            uint256 swappedUsdc = _swap(
                otherToken,
                address(asset),
                stable,
                factory,
                otherAmount,
                0,
                block.timestamp + 60
            );
            usdcUnwound += swappedUsdc;
        }

        if (usdcUnwound > 0) {
            asset.safeTransfer(msg.sender, usdcUnwound);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EMERGENCY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Emergency: unstakes all LP from the gauge and sends to the keeper vault.
     * @dev    Funds always go to `keeper` (YieldSenseKeeper) to preserve accounting.
     *         Only callable by the owner (protocol multisig).
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        address to = keeper;
        if (to == address(0)) revert ZeroAddress();

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

    /**
     * @notice Sets the keeper to the YieldSenseKeeper contract address.
     * @dev    Must never be an EOA or TEE worker. Zero address rejected.
     */
    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setProfitShareBps(uint256 newBps) external onlyOwner {
        if (newBps > BPS) revert SlippageTooHigh();
        profitShareBps = newBps;
    }

    function setSlippage(uint256 newBps) external onlyOwner {
        if (newBps > 300) revert SlippageTooHigh(); // max 3% for production safety
        emit SlippageUpdated(slippageBps, newBps);
        slippageBps = newBps;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    struct SwapParams {
        address token0;
        address token1;
        bool stable;
        address otherToken;
        bool assetIsToken0;
    }

    function _convertAssetToLp(uint256 usdcAmount, uint256 amountToSwap, uint256 deadline)
        internal
        returns (uint256 lpReceived)
    {
        SwapParams memory p;
        p.token0 = pool.token0();
        p.token1 = pool.token1();
        p.stable = pool.stable();

        p.assetIsToken0 = (p.token0 == address(asset));
        p.otherToken = p.assetIsToken0 ? p.token1 : p.token0;

        uint256 actualSwap = (amountToSwap == 0 || amountToSwap >= usdcAmount) ? usdcAmount / 2 : amountToSwap;
        if (actualSwap == 0) return 0;
        uint256 otherOut = _swap(address(asset), p.otherToken, p.stable, factory, actualSwap, 0, deadline);

        uint256 assetRemaining = usdcAmount - actualSwap;

        uint256 liquidity;

        asset.approve(address(router), assetRemaining);
        IERC20(p.otherToken).approve(address(router), otherOut);

        if (p.assetIsToken0) {
            (,, liquidity) = router.addLiquidity(
                address(asset), p.otherToken, p.stable,
                assetRemaining, otherOut,
                _minOut(assetRemaining), _minOut(otherOut),
                address(this),
                deadline
            );
        } else {
            (,, liquidity) = router.addLiquidity(
                p.otherToken, address(asset), p.stable,
                otherOut, assetRemaining,
                _minOut(otherOut), _minOut(assetRemaining),
                address(this),
                deadline
            );
        }

        lpReceived = liquidity;
    }

    function _swapRewardToAsset(uint256 rewardIn, uint256 deadline, IAerodromeRouter.Route[] calldata routes)
        internal
        returns (uint256 assetOut)
    {
        IERC20(address(rewardToken)).approve(address(router), rewardIn);
        uint256 minOut = _dynamicMinOut(rewardIn, routes);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            rewardIn,
            minOut,
            routes,
            address(this),
            deadline
        );
        assetOut = amounts[amounts.length - 1];
    }

    function _compoundRewardToLp(uint256 rewardIn, uint256 amountToSwap, uint256 deadline, IAerodromeRouter.Route[] calldata routes)
        internal
        returns (uint256 lpMinted)
    {
        uint256 assetTotal = _swapRewardToAsset(rewardIn, deadline, routes);
        if (assetTotal == 0) return 0;

        SwapParams memory p;
        p.token0 = pool.token0();
        p.token1 = pool.token1();
        p.stable = pool.stable();

        p.assetIsToken0 = (p.token0 == address(asset));
        p.otherToken = p.assetIsToken0 ? p.token1 : p.token0;

        uint256 actualSwap = (amountToSwap == 0 || amountToSwap >= assetTotal) ? assetTotal / 2 : amountToSwap;
        uint256 otherOut = _swap(address(asset), p.otherToken, p.stable, factory, actualSwap, 0, deadline);
        uint256 assetRem = assetTotal - actualSwap;

        asset.approve(address(router), assetRem);
        IERC20(p.otherToken).approve(address(router), otherOut);

        uint256 liq;
        if (p.assetIsToken0) {
            (,, liq) = router.addLiquidity(
                address(asset), p.otherToken, p.stable,
                assetRem, otherOut,
                _minOut(assetRem), _minOut(otherOut),
                address(this),
                deadline
            );
        } else {
            (,, liq) = router.addLiquidity(
                p.otherToken, address(asset), p.stable,
                otherOut, assetRem,
                _minOut(otherOut), _minOut(assetRem),
                address(this),
                deadline
            );
        }

        lpMinted = liq;
    }

    function _swap(
        address from,
        address to,
        bool stable,
        address factory_,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        IERC20(from).approve(address(router), amountIn);
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({ from: from, to: to, stable: stable, factory: factory_ });
        
        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minOut,
            routes,
            address(this),
            deadline
        );
        amountOut = amounts[amounts.length - 1];
    }

    function _minOut(uint256 amount) internal view returns (uint256) {
        return (amount * (BPS - slippageBps)) / BPS;
    }

    /**
     * @dev Calculates minOut based on getAmountsOut quote.
     *      If slippageBps == 0, returns exact expected output (no slippage tolerance),
     *      which is the strictest possible protection rather than no protection.
     */
    function _dynamicMinOut(uint256 amountIn, IAerodromeRouter.Route[] memory routes) internal view returns (uint256) {
        uint256[] memory amounts = router.getAmountsOut(amountIn, routes);
        uint256 expectedOut = amounts[amounts.length - 1];
        if (slippageBps == 0) return expectedOut; // zero tolerance = exact output required
        return _minOut(expectedOut);
    }
}
