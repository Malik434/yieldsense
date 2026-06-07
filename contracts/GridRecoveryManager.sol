// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IGridVaultRecovery {
    function releaseCapital(bytes32 strategyId, address user, address token, uint256 amount) external;
    function lockedStrategyBalance(bytes32 strategyId, address token) external view returns (uint256);
}

/**
 * @title GridRecoveryManager
 * @notice Temporary manager used to release inventory from legacy grid strategies
 *         when the deployed strategy manager lacks a close path.
 * @dev To use: set GridVault.manager to this contract, release the exact
 *      strategy inventory, then set GridVault.manager back to the active manager.
 */
contract GridRecoveryManager is Ownable {
    error LengthMismatch();
    error InvalidAmount();
    error InsufficientLockedBalance();

    event StrategyInventoryRecovered(
        bytes32 indexed strategyId,
        address indexed user,
        address indexed token,
        uint256 amount
    );

    IGridVaultRecovery public immutable vault;

    constructor(address initialOwner, address vault_) Ownable(initialOwner) {
        vault = IGridVaultRecovery(vault_);
    }

    function releaseStrategyInventory(
        bytes32 strategyId,
        address user,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external onlyOwner {
        if (tokens.length != amounts.length) revert LengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 amount = amounts[i];
            if (amount == 0) revert InvalidAmount();
            if (vault.lockedStrategyBalance(strategyId, tokens[i]) < amount) {
                revert InsufficientLockedBalance();
            }

            vault.releaseCapital(strategyId, user, tokens[i], amount);
            emit StrategyInventoryRecovered(strategyId, user, tokens[i], amount);
        }
    }
}
