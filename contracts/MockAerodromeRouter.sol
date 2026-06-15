// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockAerodromeRouter {
    using SafeERC20 for IERC20;

    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    uint256 public numerator = 1;
    uint256 public denominator = 1;
    bool public shouldRevert;

    function setRate(uint256 numerator_, uint256 denominator_) external {
        require(numerator_ > 0 && denominator_ > 0, "bad rate");
        numerator = numerator_;
        denominator = denominator_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        require(!shouldRevert, "mock swap revert");
        require(routes.length > 0, "empty routes");
        IERC20(routes[0].from).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * numerator) / denominator;
        require(amountOut >= amountOutMin, "slippage");

        IERC20(routes[routes.length - 1].to).safeTransfer(to, amountOut);

        amounts = new uint256[](routes.length + 1);
        amounts[0] = amountIn;
        amounts[routes.length] = amountOut;
    }
}
