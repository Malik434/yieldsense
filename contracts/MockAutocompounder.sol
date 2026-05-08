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
 * @dev    Replaces the real Aerodrome integration for local / Base Sepolia testing.
 *         Does NOT interact with any external protocol.
 *
 *         Simulates a harvest by minting a small USDC reward (if the contract holds USDC)
 *         or simply incrementing an internal counter so the Keeper can test the full flow.
 *
 * Usage:
 *   1. Deploy MockAutocompounder(assetAddress).
 *   2. Transfer some USDC to it (this simulates staked LP earning yield).
 *   3. Call harvestAndCompound() — it will set pendingProfit to 10% of its balance.
 *   4. Call pullProfit(amount, to) — transfers the USDC to the Keeper.
 */
contract MockAutocompounder is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public keeper;

    uint256 public pendingProfit;
    uint256 public lastHarvestAt;
    uint256 public totalCompounded;

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

    /**
     * @notice Simulates a harvest.
     */
    function harvestAndCompound(uint256 /*minLpOut*/, uint256 /*amountToSwap*/, uint256 /*deadline*/, Route[] calldata /*routes*/) external onlyKeeper {
        uint256 bal = asset.balanceOf(address(this));
        // Simulate: 10% of held balance becomes profit
        pendingProfit = bal / 10;
        lastHarvestAt = block.timestamp;
        totalCompounded += pendingProfit;
        emit MockHarvested(pendingProfit, block.timestamp);
    }

    function pullProfit(uint256 amount, address to) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingProfit) revert InsufficientPendingProfit();
        pendingProfit -= amount;
        asset.safeTransfer(to, amount);
        emit ProfitPulled(to, amount);
    }

    function depositIntoPool(uint256 usdcAmount, uint256 /*amountToSwap*/) external onlyKeeper {
        // Simulate receiving funds — just hold them
        asset.safeTransferFrom(msg.sender, address(this), usdcAmount);
    }

    function unwindLp(uint256 lpAmount) external onlyKeeper returns (uint256 usdcUnwound) {
        // In this mock, we treat lpAmount as asset units 1:1 for simplicity
        asset.safeTransfer(msg.sender, lpAmount);
        return lpAmount;
    }

    function getDeployedValueInUSDC() external view returns (uint256) {
        // Mock returns its entire balance minus pending profit (which is already accounted for in vault usually)
        // Actually, YieldSenseKeeper.totalAssets adds deployedValue + vaultBalance.
        // If pendingProfit is in autocompounder, it should be included in deployedValue.
        return asset.balanceOf(address(this));
    }

    function pendingRewards() external pure returns (uint256) { return 0; }
    function stakedLpBalance() external pure returns (uint256) { return 0; }

    /// @notice Seed the mock with USDC to simulate earned rewards.
    function seed(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }
}
