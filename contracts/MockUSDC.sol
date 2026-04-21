// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDC
 * @notice A mintable ERC20 token for testnet environments.
 * @dev Allows anyone to mint tokens for testing YieldSense mechanics.
 */
contract MockUSDC is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(uint8 decimals_) ERC20("Mock USDC", "USDC") Ownable(msg.sender) {
        _decimals = decimals_;
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Allows anyone to mint test tokens.
     * @param amount The amount to mint (in wei).
     */
    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /**
     * @notice Owner can mint to a specific address.
     * @param to The address to receive the minted tokens.
     * @param amount The amount to mint.
     */
    function mintTo(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
