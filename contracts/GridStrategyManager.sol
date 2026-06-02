// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGridVault {
    function lockCapital(bytes32 strategyId, address user, address token, uint256 amount) external;
    function releaseCapital(bytes32 strategyId, address user, address token, uint256 amount) external;
    function increaseStrategyInventory(bytes32 strategyId, address token, uint256 amount) external;
    function decreaseStrategyInventory(bytes32 strategyId, address token, uint256 amount) external;
}

/**
 * @title GridStrategyManager
 * @notice Single source of truth for grid strategy lifecycle, inventory, gas accounting, and execution state.
 */
contract GridStrategyManager is Ownable, ReentrancyGuard {
    enum StrategyStatus {
        Draft,
        Funded,
        Active,
        Paused,
        GasPaused,
        Archived,
        Closed
    }

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
        StrategyStatus status;
        uint64 createdAt;
        uint64 updatedAt;
    }

    struct PairConfig {
        address baseToken;
        address quoteToken;
        bool enabled;
        uint256 minGasReserveQuote;
        uint256 maxGasCostQuotePerTrade;
        uint64 minExecutionInterval;
    }

    struct ChainStateSnapshot {
        uint32 strategyVersion;
        int32 currentGridLevel;
        uint64 lastExecutionAt;
        uint256 quoteBalance;
        uint256 baseBalance;
    }

    error ZeroAddress();
    error InvalidAmount();
    error InvalidStrategy();
    error InvalidStatus();
    error NotStrategyOwner();
    error PairDisabled(bytes32 pairId);
    error UnauthorizedRouter();
    error StaleExecution(bytes32 strategyId, uint32 expectedVersion, uint32 actualVersion);
    error CooldownActive();
    error InsufficientInventory();
    error InsufficientGasReserve();
    error SystemPaused();

    event PairConfigured(bytes32 indexed pairId, address indexed baseToken, address indexed quoteToken, bool enabled);
    event StrategyCreated(bytes32 indexed strategyId, address indexed owner, bytes32 indexed pairId, bytes32 encryptedPayloadHash);
    event StrategyCapitalAllocated(bytes32 indexed strategyId, uint256 tradingAmountQuote, uint256 gasReserveQuote);
    event StrategyStatusUpdated(bytes32 indexed strategyId, StrategyStatus status);
    event StrategyPayloadUpdated(bytes32 indexed strategyId, bytes32 encryptedPayloadHash, uint32 strategyVersion);
    event StrategyPositionUpdated(
        bytes32 indexed strategyId,
        uint256 quoteBalance,
        uint256 baseBalance,
        uint256 avgEntryPrice,
        int256 realizedPnlQuote,
        uint256 feesPaidQuote
    );
    event ExecutionStale(bytes32 indexed strategyId, uint32 expectedVersion, uint32 actualVersion);
    event ExecutionReverted(bytes32 indexed strategyId, bytes32 indexed jobId, string reason);
    event GasReserveAdded(bytes32 indexed strategyId, uint256 amount);
    event GasReserveSpent(bytes32 indexed strategyId, uint256 amount, bytes32 indexed executionId);
    event StrategyGasPaused(bytes32 indexed strategyId);
    event PauseAllUpdated(bool paused);
    event ExecutionRouterUpdated(address indexed router);

    IGridVault public immutable vault;
    address public executionRouter;
    bool public pausedAll;
    bool public testingGasSubsidyMode;

    mapping(bytes32 => GridStrategy) private strategies;
    mapping(bytes32 => PairConfig) public pairConfig;

    modifier onlyExecutionRouter() {
        if (msg.sender != executionRouter) revert UnauthorizedRouter();
        _;
    }

    modifier onlyStrategyOwner(bytes32 strategyId) {
        if (strategies[strategyId].owner != msg.sender) revert NotStrategyOwner();
        _;
    }

    modifier whenSystemActive() {
        if (pausedAll) revert SystemPaused();
        _;
    }

    constructor(address initialOwner, address vault_) Ownable(initialOwner) {
        if (initialOwner == address(0) || vault_ == address(0)) revert ZeroAddress();
        vault = IGridVault(vault_);
    }

    function configurePair(
        bytes32 pairId,
        address baseToken,
        address quoteToken,
        bool enabled,
        uint256 minGasReserveQuote,
        uint256 maxGasCostQuotePerTrade,
        uint64 minExecutionInterval
    ) external onlyOwner {
        if (pairId == bytes32(0) || baseToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        pairConfig[pairId] = PairConfig({
            baseToken: baseToken,
            quoteToken: quoteToken,
            enabled: enabled,
            minGasReserveQuote: minGasReserveQuote,
            maxGasCostQuotePerTrade: maxGasCostQuotePerTrade,
            minExecutionInterval: minExecutionInterval
        });
        emit PairConfigured(pairId, baseToken, quoteToken, enabled);
    }

    function setExecutionRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        executionRouter = router;
        emit ExecutionRouterUpdated(router);
    }

    function setPauseAll(bool paused) external onlyOwner {
        pausedAll = paused;
        emit PauseAllUpdated(paused);
    }

    function setTestingGasSubsidyMode(bool enabled) external onlyOwner {
        testingGasSubsidyMode = enabled;
    }

    function createStrategy(bytes32 pairId, bytes32 encryptedPayloadHash) external whenSystemActive returns (bytes32 strategyId) {
        PairConfig memory pair = pairConfig[pairId];
        if (!pair.enabled) revert PairDisabled(pairId);

        strategyId = keccak256(abi.encode(msg.sender, pairId, encryptedPayloadHash, block.chainid, block.timestamp));
        GridStrategy storage strategy = strategies[strategyId];
        if (strategy.owner != address(0)) revert InvalidStrategy();

        uint64 nowTs = uint64(block.timestamp);
        strategy.id = strategyId;
        strategy.owner = msg.sender;
        strategy.pairId = pairId;
        strategy.baseToken = pair.baseToken;
        strategy.quoteToken = pair.quoteToken;
        strategy.encryptedPayloadHash = encryptedPayloadHash;
        strategy.strategyVersion = 1;
        strategy.status = StrategyStatus.Draft;
        strategy.createdAt = nowTs;
        strategy.updatedAt = nowTs;

        emit StrategyCreated(strategyId, msg.sender, pairId, encryptedPayloadHash);
    }

    function allocateCapital(bytes32 strategyId, uint256 tradingAmountQuote, uint256 gasReserveQuote)
        external
        nonReentrant
        whenSystemActive
        onlyStrategyOwner(strategyId)
    {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status != StrategyStatus.Draft && strategy.status != StrategyStatus.Funded) revert InvalidStatus();
        if (tradingAmountQuote == 0) revert InvalidAmount();

        PairConfig memory pair = pairConfig[strategy.pairId];
        if (!pair.enabled) revert PairDisabled(strategy.pairId);

        uint256 totalLock = tradingAmountQuote + gasReserveQuote;
        vault.lockCapital(strategyId, msg.sender, strategy.quoteToken, totalLock);

        strategy.allocatedQuote += tradingAmountQuote;
        strategy.quoteBalance += tradingAmountQuote;
        strategy.gasReserveQuote += gasReserveQuote;
        strategy.maxGasCostQuotePerTrade = pair.maxGasCostQuotePerTrade;
        strategy.status = StrategyStatus.Funded;
        strategy.updatedAt = uint64(block.timestamp);

        emit StrategyCapitalAllocated(strategyId, tradingAmountQuote, gasReserveQuote);
        if (gasReserveQuote > 0) emit GasReserveAdded(strategyId, gasReserveQuote);
        emit StrategyStatusUpdated(strategyId, StrategyStatus.Funded);
    }

    function addGasReserve(bytes32 strategyId, uint256 amount)
        external
        nonReentrant
        whenSystemActive
        onlyStrategyOwner(strategyId)
    {
        if (amount == 0) revert InvalidAmount();
        GridStrategy storage strategy = _existingStrategy(strategyId);
        vault.lockCapital(strategyId, msg.sender, strategy.quoteToken, amount);
        strategy.gasReserveQuote += amount;
        strategy.updatedAt = uint64(block.timestamp);
        if (strategy.status == StrategyStatus.GasPaused) {
            strategy.status = StrategyStatus.Paused;
            emit StrategyStatusUpdated(strategyId, StrategyStatus.Paused);
        }
        emit GasReserveAdded(strategyId, amount);
    }

    function enableStrategy(bytes32 strategyId) external whenSystemActive onlyStrategyOwner(strategyId) {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status != StrategyStatus.Funded && strategy.status != StrategyStatus.Paused) revert InvalidStatus();
        PairConfig memory pair = pairConfig[strategy.pairId];
        if (!pair.enabled) revert PairDisabled(strategy.pairId);
        if (!testingGasSubsidyMode && strategy.gasReserveQuote < pair.minGasReserveQuote) revert InsufficientGasReserve();

        strategy.status = StrategyStatus.Active;
        strategy.updatedAt = uint64(block.timestamp);
        emit StrategyStatusUpdated(strategyId, StrategyStatus.Active);
    }

    function pauseStrategy(bytes32 strategyId) external onlyStrategyOwner(strategyId) {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status != StrategyStatus.Active && strategy.status != StrategyStatus.GasPaused) revert InvalidStatus();
        strategy.status = StrategyStatus.Paused;
        strategy.updatedAt = uint64(block.timestamp);
        emit StrategyStatusUpdated(strategyId, StrategyStatus.Paused);
    }

    function archiveStrategy(bytes32 strategyId) external onlyStrategyOwner(strategyId) {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status == StrategyStatus.Active) revert InvalidStatus();
        strategy.status = StrategyStatus.Archived;
        strategy.updatedAt = uint64(block.timestamp);
        emit StrategyStatusUpdated(strategyId, StrategyStatus.Archived);
    }

    function updatePayload(bytes32 strategyId, bytes32 encryptedPayloadHash) external whenSystemActive onlyStrategyOwner(strategyId) {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status == StrategyStatus.Active) revert InvalidStatus();
        strategy.encryptedPayloadHash = encryptedPayloadHash;
        strategy.strategyVersion += 1;
        strategy.updatedAt = uint64(block.timestamp);
        emit StrategyPayloadUpdated(strategyId, encryptedPayloadHash, strategy.strategyVersion);
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
    ) external onlyExecutionRouter whenSystemActive {
        GridStrategy storage strategy = _validateExecutable(strategyId, snapshot, gasCostQuote);
        if (quoteSpent == 0 || baseReceived == 0) revert InvalidAmount();
        if (strategy.quoteBalance < quoteSpent) revert InsufficientInventory();

        strategy.quoteBalance -= quoteSpent;
        strategy.baseBalance += baseReceived;
        vault.decreaseStrategyInventory(strategyId, strategy.quoteToken, quoteSpent);
        vault.increaseStrategyInventory(strategyId, strategy.baseToken, baseReceived);
        strategy.avgEntryPrice = avgEntryPrice;
        strategy.feesPaidQuote += dexFeeQuote;
        strategy.lastExecutionAt = uint64(block.timestamp);
        strategy.currentGridLevel = nextGridLevel;
        _spendGas(strategy, strategyId, executionId, gasCostQuote);

        emit StrategyPositionUpdated(
            strategyId,
            strategy.quoteBalance,
            strategy.baseBalance,
            strategy.avgEntryPrice,
            strategy.realizedPnlQuote,
            strategy.feesPaidQuote
        );
    }

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
    ) external onlyExecutionRouter whenSystemActive {
        GridStrategy storage strategy = _validateExecutable(strategyId, snapshot, gasCostQuote);
        if (baseSold == 0 || quoteReceived == 0) revert InvalidAmount();
        if (strategy.baseBalance < baseSold) revert InsufficientInventory();

        strategy.baseBalance -= baseSold;
        strategy.quoteBalance += quoteReceived;
        vault.decreaseStrategyInventory(strategyId, strategy.baseToken, baseSold);
        vault.increaseStrategyInventory(strategyId, strategy.quoteToken, quoteReceived);
        strategy.realizedPnlQuote += realizedPnlQuote;
        strategy.feesPaidQuote += dexFeeQuote;
        strategy.lastExecutionAt = uint64(block.timestamp);
        strategy.currentGridLevel = nextGridLevel;
        _spendGas(strategy, strategyId, executionId, gasCostQuote);

        emit StrategyPositionUpdated(
            strategyId,
            strategy.quoteBalance,
            strategy.baseBalance,
            strategy.avgEntryPrice,
            strategy.realizedPnlQuote,
            strategy.feesPaidQuote
        );
    }

    function markExecutionReverted(bytes32 strategyId, bytes32 executionId, string calldata reason) external onlyExecutionRouter {
        emit ExecutionReverted(strategyId, executionId, reason);
    }

    function markStrategyGasPaused(bytes32 strategyId) external onlyExecutionRouter {
        GridStrategy storage strategy = _existingStrategy(strategyId);
        if (strategy.status != StrategyStatus.Active) revert InvalidStatus();
        strategy.status = StrategyStatus.GasPaused;
        strategy.updatedAt = uint64(block.timestamp);
        emit StrategyGasPaused(strategyId);
        emit StrategyStatusUpdated(strategyId, StrategyStatus.GasPaused);
    }

    function getStrategy(bytes32 strategyId) external view returns (GridStrategy memory) {
        return _existingStrategyView(strategyId);
    }

    function getChainStateSnapshot(bytes32 strategyId) external view returns (ChainStateSnapshot memory) {
        GridStrategy storage strategy = _existingStrategyView(strategyId);
        return ChainStateSnapshot({
            strategyVersion: strategy.strategyVersion,
            currentGridLevel: strategy.currentGridLevel,
            lastExecutionAt: strategy.lastExecutionAt,
            quoteBalance: strategy.quoteBalance,
            baseBalance: strategy.baseBalance
        });
    }

    function _validateExecutable(bytes32 strategyId, ChainStateSnapshot calldata snapshot, uint256 gasCostQuote)
        internal
        returns (GridStrategy storage strategy)
    {
        strategy = _existingStrategy(strategyId);
        if (strategy.status != StrategyStatus.Active) revert InvalidStatus();
        PairConfig memory pair = pairConfig[strategy.pairId];
        if (!pair.enabled) revert PairDisabled(strategy.pairId);
        if (strategy.strategyVersion != snapshot.strategyVersion) {
            emit ExecutionStale(strategyId, snapshot.strategyVersion, strategy.strategyVersion);
            revert StaleExecution(strategyId, snapshot.strategyVersion, strategy.strategyVersion);
        }
        if (
            strategy.currentGridLevel != snapshot.currentGridLevel ||
            strategy.lastExecutionAt != snapshot.lastExecutionAt ||
            strategy.quoteBalance != snapshot.quoteBalance ||
            strategy.baseBalance != snapshot.baseBalance
        ) {
            emit ExecutionStale(strategyId, snapshot.strategyVersion, strategy.strategyVersion);
            revert StaleExecution(strategyId, snapshot.strategyVersion, strategy.strategyVersion);
        }
        if (block.timestamp < uint256(strategy.lastExecutionAt) + pair.minExecutionInterval) revert CooldownActive();
        if (!testingGasSubsidyMode) {
            if (strategy.gasReserveQuote < gasCostQuote || strategy.gasReserveQuote < pair.minGasReserveQuote) {
                revert InsufficientGasReserve();
            }
        }
        if (gasCostQuote > strategy.maxGasCostQuotePerTrade && strategy.maxGasCostQuotePerTrade != 0) revert InsufficientGasReserve();
    }

    function _spendGas(GridStrategy storage strategy, bytes32 strategyId, bytes32 executionId, uint256 gasCostQuote) internal {
        if (gasCostQuote == 0 || testingGasSubsidyMode) return;
        strategy.gasReserveQuote -= gasCostQuote;
        strategy.gasSpentQuote += gasCostQuote;
        emit GasReserveSpent(strategyId, gasCostQuote, executionId);
    }

    function _existingStrategy(bytes32 strategyId) internal view returns (GridStrategy storage strategy) {
        strategy = strategies[strategyId];
        if (strategy.owner == address(0)) revert InvalidStrategy();
    }

    function _existingStrategyView(bytes32 strategyId) internal view returns (GridStrategy storage strategy) {
        strategy = strategies[strategyId];
        if (strategy.owner == address(0)) revert InvalidStrategy();
    }
}
