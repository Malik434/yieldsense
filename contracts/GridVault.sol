// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GridVault
 * @notice Custody-only vault for grid trading capital.
 * @dev Strategy accounting lives in GridStrategyManager. This contract only
 *      tracks user free balances and strategy-locked balances.
 */
contract GridVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error UnsupportedToken(address token);
    error InvalidAmount();
    error InsufficientAvailableBalance();
    error UnauthorizedManager();
    error UnauthorizedRouter();
    error SystemPaused();
    error ZeroAddress();

    event TokenSupported(address indexed token, bool supported);
    event ManagerUpdated(address indexed manager);
    event ExecutionRouterUpdated(address indexed router);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event StrategyCapitalLocked(bytes32 indexed strategyId, address indexed user, address indexed token, uint256 amount);
    event StrategyCapitalReleased(bytes32 indexed strategyId, address indexed user, address indexed token, uint256 amount);
    event StrategyInventoryUpdated(bytes32 indexed strategyId, address indexed token, int256 delta, uint256 lockedBalance);
    event ExecutionTransfer(address indexed token, address indexed to, uint256 amount);
    event PauseAllUpdated(bool paused);

    mapping(address => bool) public supportedToken;
    mapping(address => mapping(address => uint256)) public availableBalance;
    mapping(bytes32 => mapping(address => uint256)) public lockedStrategyBalance;

    address public manager;
    address public executionRouter;
    bool public pausedAll;

    modifier onlyManager() {
        if (msg.sender != manager) revert UnauthorizedManager();
        _;
    }

    modifier onlyExecutionRouter() {
        if (msg.sender != executionRouter) revert UnauthorizedRouter();
        _;
    }

    modifier whenSystemActive() {
        if (pausedAll) revert SystemPaused();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        supportedToken[token] = supported;
        emit TokenSupported(token, supported);
    }

    function setManager(address newManager) external onlyOwner {
        if (newManager == address(0)) revert ZeroAddress();
        manager = newManager;
        emit ManagerUpdated(newManager);
    }

    function setExecutionRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        executionRouter = newRouter;
        emit ExecutionRouterUpdated(newRouter);
    }

    function setPauseAll(bool paused) external onlyOwner {
        pausedAll = paused;
        emit PauseAllUpdated(paused);
    }

    function deposit(address token, uint256 amount) external nonReentrant whenSystemActive {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();

        availableBalance[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();
        if (availableBalance[msg.sender][token] < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }

    function lockCapital(bytes32 strategyId, address user, address token, uint256 amount) external onlyManager whenSystemActive {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();
        if (availableBalance[user][token] < amount) revert InsufficientAvailableBalance();

        availableBalance[user][token] -= amount;
        lockedStrategyBalance[strategyId][token] += amount;

        emit StrategyCapitalLocked(strategyId, user, token, amount);
    }

    function releaseCapital(bytes32 strategyId, address user, address token, uint256 amount) external onlyManager {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();
        if (lockedStrategyBalance[strategyId][token] < amount) revert InvalidAmount();

        lockedStrategyBalance[strategyId][token] -= amount;
        availableBalance[user][token] += amount;

        emit StrategyCapitalReleased(strategyId, user, token, amount);
    }

    function increaseStrategyInventory(bytes32 strategyId, address token, uint256 amount) external onlyManager {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();

        lockedStrategyBalance[strategyId][token] += amount;
        emit StrategyInventoryUpdated(strategyId, token, int256(amount), lockedStrategyBalance[strategyId][token]);
    }

    function decreaseStrategyInventory(bytes32 strategyId, address token, uint256 amount) external onlyManager {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();
        if (lockedStrategyBalance[strategyId][token] < amount) revert InvalidAmount();

        lockedStrategyBalance[strategyId][token] -= amount;
        emit StrategyInventoryUpdated(strategyId, token, -int256(amount), lockedStrategyBalance[strategyId][token]);
    }

    function transferForExecution(address token, address to, uint256 amount) external onlyExecutionRouter whenSystemActive {
        if (!supportedToken[token]) revert UnsupportedToken(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransfer(to, amount);
        emit ExecutionTransfer(token, to, amount);
    }
}
