// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        // Mint 1 million tokens to the deployer for testing
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }

    // Allow anyone to mint tokens for testing
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
