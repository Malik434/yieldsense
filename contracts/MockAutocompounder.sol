// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

struct Route {
    address from;
    address to;
    bool stable;
    address factory;
}

/**
 * @title MockAutocompounder
 * @notice Testnet stub for the AerodromeAutocompounder interface.
 *
 * @dev    Updated to match the hardened IAerodromeAutocompounder interface:
 *         - pullProfit(uint256) — no address param, sends to keeper
 *         - depositIntoPool(uint256, uint256, uint256) — includes minLpOut
 *         - Exposes pool(), factory(), asset(), rewardToken(), keeper(),
 *           router(), maxTotalAssets(), slippageBps() view stubs
 */
contract MockAutocompounder is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public keeper;

    uint256 public pendingProfit;
    uint256 public lastHarvestAt;
    uint256 public totalCompounded;

    // ── Stub view returns for interface compliance ────────────────────────────
    address public pool     = address(0xB00B5);  // dummy — overridden in tests that need it
    address public factory  = address(0xFAC1);
    address public rewardToken_ = address(0xAE20);
    address public router_  = address(0x2091E);
    uint256 public maxTotalAssets = type(uint256).max;
    uint256 public slippageBps = 100;

    event MockHarvested(uint256 profit, uint256 timestamp);
    event ProfitPulled(address indexed to, uint256 amount);

    error Unauthorized();
    error ZeroAmount();
    error InsufficientPendingProfit();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(address asset_) Ownable(msg.sender) {
        asset = IERC20(asset_);
        keeper = msg.sender;
    }

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
    }

    /// @notice Allow tests to configure the pool address returned by pool().
    function setPool(address pool_) external onlyOwner {
        pool = pool_;
    }

    /// @notice Allow tests to configure the factory address returned by factory().
    function setFactory(address factory_) external onlyOwner {
        factory = factory_;
    }

    function harvestAndCompound(
        uint256 /*minLpOut*/,
        uint256 /*amountToSwap*/,
        uint256 /*deadline*/,
        Route[] calldata /*routes*/
    ) external onlyKeeper {
        uint256 bal = asset.balanceOf(address(this));
        pendingProfit = bal / 10;
        lastHarvestAt = block.timestamp;
        totalCompounded += pendingProfit;
        emit MockHarvested(pendingProfit, block.timestamp);
    }

    /// @notice Updated: always sends to keeper (no arbitrary recipient).
    function pullProfit(uint256 amount) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingProfit) revert InsufficientPendingProfit();
        pendingProfit -= amount;
        asset.safeTransfer(keeper, amount);
        emit ProfitPulled(keeper, amount);
    }

    /// @notice Updated: now accepts minLpOut (ignored in mock, but interface-compliant).
    function depositIntoPool(
        uint256 usdcAmount,
        uint256 /*amountToSwap*/,
        uint256 /*minLpOut*/
    ) external onlyKeeper {
        asset.safeTransferFrom(msg.sender, address(this), usdcAmount);
    }

    function unwindLp(uint256 lpAmount) external onlyKeeper returns (uint256 usdcUnwound) {
        asset.safeTransfer(msg.sender, lpAmount);
        return lpAmount;
    }

    function getDeployedValueInUSDC() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function pendingRewards() external pure returns (uint256) { return 0; }
    function stakedLpBalance() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Seed the mock with USDC to simulate earned rewards.
    function seed(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }
}
