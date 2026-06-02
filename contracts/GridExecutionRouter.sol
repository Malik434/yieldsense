// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IExecutorRegistryGrid {
    function GRID_EXECUTOR() external view returns (bytes32);
    function isAuthorized(address processor, bytes32 role) external view returns (bool);
}

interface IGridStrategyManagerRouter {
    struct GridStrategy {
        bytes32 id;
        address owner;
        bytes32 pairId;
        address baseToken;
        address quoteToken;
        uint256 allocatedQuote;
        uint256 quoteBalance;
        uint256 baseBalance;
        uint256 avgEntryPrice;
        int256 realizedPnlQuote;
        uint256 feesPaidQuote;
        uint256 gasReserveQuote;
        uint256 gasSpentQuote;
        uint256 maxGasCostQuotePerTrade;
        uint64 lastExecutionAt;
        int32 currentGridLevel;
        uint32 strategyVersion;
        bytes32 encryptedPayloadHash;
        uint8 status;
        uint64 createdAt;
        uint64 updatedAt;
    }

    struct ChainStateSnapshot {
        uint32 strategyVersion;
        int32 currentGridLevel;
        uint64 lastExecutionAt;
        uint256 quoteBalance;
        uint256 baseBalance;
    }

    function recordBuySettlement(
        bytes32 strategyId,
        bytes32 executionId,
        ChainStateSnapshot calldata snapshot,
        uint256 quoteSpent,
        uint256 baseReceived,
        uint256 avgEntryPrice,
        uint256 dexFeeQuote,
        uint256 gasCostQuote,
        int32 nextGridLevel
    ) external;

    function recordSellSettlement(
        bytes32 strategyId,
        bytes32 executionId,
        ChainStateSnapshot calldata snapshot,
        uint256 baseSold,
        uint256 quoteReceived,
        int256 realizedPnlQuote,
        uint256 dexFeeQuote,
        uint256 gasCostQuote,
        int32 nextGridLevel
    ) external;

    function markExecutionReverted(bytes32 strategyId, bytes32 executionId, string calldata reason) external;
    function markStrategyGasPaused(bytes32 strategyId) external;
    function getStrategy(bytes32 strategyId) external view returns (GridStrategy memory);
}

interface IGridVaultRouter {
    function transferForExecution(address token, address to, uint256 amount) external;
}

interface IAerodromeGridRouter {
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
}

/**
 * @title GridExecutionRouter
 * @notice Authorization and settlement boundary for grid executions.
 * @dev Aerodrome swap wiring belongs in Phase 3. This router already enforces
 *      GRID_EXECUTOR authorization and receipt-driven settlement semantics.
 */
contract GridExecutionRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error UnauthorizedExecutor();
    error PairDisabled(bytes32 pairId);
    error RouterNotAllowed(address router);
    error SystemPaused();
    error InvalidRoute();
    error InvalidAmount();
    error SlippageTooHigh(uint256 received, uint256 minimum);
    error StaleQuote();

    event PairAllowed(bytes32 indexed pairId, bool allowed);
    event RouterAllowed(address indexed router, bool allowed);
    event PauseAllUpdated(bool paused);
    event GridBuySettled(bytes32 indexed strategyId, bytes32 indexed executionId, uint256 quoteSpent, uint256 baseReceived);
    event GridSellSettled(bytes32 indexed strategyId, bytes32 indexed executionId, uint256 baseSold, uint256 quoteReceived);
    event AerodromeBuyExecuted(bytes32 indexed strategyId, bytes32 indexed executionId, address indexed router, uint256 quoteSpent, uint256 baseReceived);
    event AerodromeSellExecuted(bytes32 indexed strategyId, bytes32 indexed executionId, address indexed router, uint256 baseSold, uint256 quoteReceived);
    event GridExecutionReverted(bytes32 indexed strategyId, bytes32 indexed executionId, string reason);
    event GridStrategyGasPaused(bytes32 indexed strategyId);

    IExecutorRegistryGrid public immutable executorRegistry;
    IGridStrategyManagerRouter public immutable strategyManager;
    IGridVaultRouter public immutable vault;

    mapping(bytes32 => bool) public pairAllowed;
    mapping(address => bool) public routerAllowed;
    bool public pausedAll;

    modifier onlyGridExecutor() {
        if (!executorRegistry.isAuthorized(msg.sender, executorRegistry.GRID_EXECUTOR())) revert UnauthorizedExecutor();
        _;
    }

    modifier whenSystemActive() {
        if (pausedAll) revert SystemPaused();
        _;
    }

    constructor(address initialOwner, address executorRegistry_, address strategyManager_, address vault_) Ownable(initialOwner) {
        if (initialOwner == address(0) || executorRegistry_ == address(0) || strategyManager_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        executorRegistry = IExecutorRegistryGrid(executorRegistry_);
        strategyManager = IGridStrategyManagerRouter(strategyManager_);
        vault = IGridVaultRouter(vault_);
    }

    function setPairAllowed(bytes32 pairId, bool allowed) external onlyOwner {
        pairAllowed[pairId] = allowed;
        emit PairAllowed(pairId, allowed);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        routerAllowed[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    function setPauseAll(bool paused) external onlyOwner {
        pausedAll = paused;
        emit PauseAllUpdated(paused);
    }

    function executeAerodromeBuy(
        bytes32 strategyId,
        bytes32 pairId,
        bytes32 executionId,
        address dexRouter,
        IGridStrategyManagerRouter.ChainStateSnapshot calldata snapshot,
        uint256 quoteAmount,
        uint256 minBaseOut,
        uint256 avgEntryPrice,
        uint256 dexFeeQuote,
        uint256 gasCostQuote,
        int32 nextGridLevel,
        uint256 deadline,
        IAerodromeGridRouter.Route[] calldata routes
    ) external onlyGridExecutor whenSystemActive nonReentrant {
        _validateRoute(pairId, dexRouter);
        if (quoteAmount == 0 || minBaseOut == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert StaleQuote();

        IGridStrategyManagerRouter.GridStrategy memory strategy = strategyManager.getStrategy(strategyId);
        _validateSwapPath(routes, strategy.quoteToken, strategy.baseToken);

        uint256 baseBefore = IERC20(strategy.baseToken).balanceOf(address(vault));
        vault.transferForExecution(strategy.quoteToken, address(this), quoteAmount);
        IERC20(strategy.quoteToken).forceApprove(dexRouter, quoteAmount);

        IAerodromeGridRouter(dexRouter).swapExactTokensForTokens(
            quoteAmount,
            minBaseOut,
            routes,
            address(vault),
            deadline
        );

        uint256 baseReceived = IERC20(strategy.baseToken).balanceOf(address(vault)) - baseBefore;
        if (baseReceived < minBaseOut) revert SlippageTooHigh(baseReceived, minBaseOut);

        strategyManager.recordBuySettlement(
            strategyId,
            executionId,
            snapshot,
            quoteAmount,
            baseReceived,
            avgEntryPrice,
            dexFeeQuote,
            gasCostQuote,
            nextGridLevel
        );

        emit AerodromeBuyExecuted(strategyId, executionId, dexRouter, quoteAmount, baseReceived);
        emit GridBuySettled(strategyId, executionId, quoteAmount, baseReceived);
    }

    function executeAerodromeSell(
        bytes32 strategyId,
        bytes32 pairId,
        bytes32 executionId,
        address dexRouter,
        IGridStrategyManagerRouter.ChainStateSnapshot calldata snapshot,
        uint256 baseAmount,
        uint256 minQuoteOut,
        int256 realizedPnlQuote,
        uint256 dexFeeQuote,
        uint256 gasCostQuote,
        int32 nextGridLevel,
        uint256 deadline,
        IAerodromeGridRouter.Route[] calldata routes
    ) external onlyGridExecutor whenSystemActive nonReentrant {
        _validateRoute(pairId, dexRouter);
        if (baseAmount == 0 || minQuoteOut == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert StaleQuote();

        IGridStrategyManagerRouter.GridStrategy memory strategy = strategyManager.getStrategy(strategyId);
        _validateSwapPath(routes, strategy.baseToken, strategy.quoteToken);

        uint256 quoteBefore = IERC20(strategy.quoteToken).balanceOf(address(vault));
        vault.transferForExecution(strategy.baseToken, address(this), baseAmount);
        IERC20(strategy.baseToken).forceApprove(dexRouter, baseAmount);

        IAerodromeGridRouter(dexRouter).swapExactTokensForTokens(
            baseAmount,
            minQuoteOut,
            routes,
            address(vault),
            deadline
        );

        uint256 quoteReceived = IERC20(strategy.quoteToken).balanceOf(address(vault)) - quoteBefore;
        if (quoteReceived < minQuoteOut) revert SlippageTooHigh(quoteReceived, minQuoteOut);

        strategyManager.recordSellSettlement(
            strategyId,
            executionId,
            snapshot,
            baseAmount,
            quoteReceived,
            realizedPnlQuote,
            dexFeeQuote,
            gasCostQuote,
            nextGridLevel
        );

        emit AerodromeSellExecuted(strategyId, executionId, dexRouter, baseAmount, quoteReceived);
        emit GridSellSettled(strategyId, executionId, baseAmount, quoteReceived);
    }

    function markExecutionReverted(bytes32 strategyId, bytes32 executionId, string calldata reason) external onlyGridExecutor {
        strategyManager.markExecutionReverted(strategyId, executionId, reason);
        emit GridExecutionReverted(strategyId, executionId, reason);
    }

    function markStrategyGasPaused(bytes32 strategyId) external onlyGridExecutor {
        strategyManager.markStrategyGasPaused(strategyId);
        emit GridStrategyGasPaused(strategyId);
    }

    function _validateRoute(bytes32 pairId, address dexRouter) internal view {
        if (!pairAllowed[pairId]) revert PairDisabled(pairId);
        if (!routerAllowed[dexRouter]) revert RouterNotAllowed(dexRouter);
    }

    function _validateSwapPath(IAerodromeGridRouter.Route[] calldata routes, address expectedFrom, address expectedTo) internal pure {
        if (routes.length == 0) revert InvalidRoute();
        if (routes[0].from != expectedFrom) revert InvalidRoute();
        if (routes[routes.length - 1].to != expectedTo) revert InvalidRoute();

        for (uint256 i = 0; i < routes.length; i++) {
            if (routes[i].from == address(0) || routes[i].to == address(0) || routes[i].factory == address(0)) {
                revert InvalidRoute();
            }
            if (i > 0 && routes[i - 1].to != routes[i].from) revert InvalidRoute();
        }
    }
}
