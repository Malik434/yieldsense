// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IAcurastConsumer {
    function verifyAcurastSignature(bytes32 digest, bytes calldata signature) external view returns (bool);
}

/**
 * @title YieldSenseKeeper
 * @notice Strategy vault with Acurast TEE-authorized trade execution.
 */
contract YieldSenseKeeper is IAcurastConsumer {
    using SafeERC20 for IERC20;

    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable asset;
    address public owner;
    address public feeRecipient;
    address public acurastSigner;

    mapping(address => uint256) public balances;
    mapping(address => uint256) public userInitialDeposit;
    mapping(uint256 => bool) public usedNonces;

    event Deposited(address indexed user, uint256 amount, uint256 balanceAfter, uint256 initialDepositAfter);
    event TradeExecuted(address indexed user, int256 pnlDelta, uint256 nonce, bytes32 digest, address recoveredSigner);
    event Withdrawn(address indexed user, uint256 grossAmount, uint256 performanceFee, uint256 netAmount);
    event AcurastSignerUpdated(address indexed signer);
    event FeeRecipientUpdated(address indexed recipient);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyAcurast(bytes32 digest, bytes calldata signature) {
        require(verifyAcurastSignature(digest, signature), "invalid acurast signature");
        _;
    }

    constructor(address asset_, address acurastSigner_) {
        require(asset_ != address(0), "asset=0");
        require(acurastSigner_ != address(0), "acurast=0");

        asset = IERC20(asset_);
        owner = msg.sender;
        feeRecipient = msg.sender;
        acurastSigner = acurastSigner_;
    }

    function setAcurastSigner(address signer) external onlyOwner {
        require(signer != address(0), "signer=0");
        acurastSigner = signer;
        emit AcurastSignerUpdated(signer);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "recipient=0");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    /**
     * @dev Records principal into `userInitialDeposit` for performance fee accounting.
     */
    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        asset.safeTransferFrom(msg.sender, address(this), amount);

        balances[msg.sender] += amount;
        userInitialDeposit[msg.sender] += amount;

        emit Deposited(msg.sender, amount, balances[msg.sender], userInitialDeposit[msg.sender]);
    }

    /**
     * @notice Applies signed PnL delta for a user, authorized by the Acurast hardware signer.
     * @dev `digest` must be keccak256(chainid, this, user, pnlDelta, nonce).
     */
    function executeTrade(
        address user,
        int256 pnlDelta,
        uint256 nonce,
        bytes32 digest,
        bytes calldata signature
    ) external onlyAcurast(digest, signature) {
        require(user != address(0), "user=0");
        require(!usedNonces[nonce], "nonce used");

        bytes32 expectedDigest = keccak256(abi.encodePacked(block.chainid, address(this), user, pnlDelta, nonce));
        require(digest == expectedDigest, "bad digest");
        usedNonces[nonce] = true;

        uint256 current = balances[user];
        if (pnlDelta >= 0) {
            balances[user] = current + uint256(pnlDelta);
        } else {
            uint256 loss = uint256(-pnlDelta);
            require(current >= loss, "loss exceeds balance");
            balances[user] = current - loss;
        }

        address recoveredSigner = ECDSA.recover(_toEthSignedMessageHash(digest), signature);
        emit TradeExecuted(user, pnlDelta, nonce, digest, recoveredSigner);
    }

    /**
     * @notice Withdraws full user balance and charges performance fee only on profit.
     */
    function withdraw() external {
        uint256 balance = balances[msg.sender];
        require(balance > 0, "balance=0");

        uint256 initialDeposit = userInitialDeposit[msg.sender];
        uint256 profit = balance > initialDeposit ? balance - initialDeposit : 0;
        uint256 performanceFee = profit > 0 ? (profit * PERFORMANCE_FEE_BPS) / BPS_DENOMINATOR : 0;
        uint256 netAmount = balance - performanceFee;

        balances[msg.sender] = 0;
        userInitialDeposit[msg.sender] = 0;

        if (performanceFee > 0) {
            asset.safeTransfer(feeRecipient, performanceFee);
        }
        asset.safeTransfer(msg.sender, netAmount);

        emit Withdrawn(msg.sender, balance, performanceFee, netAmount);
    }

    function verifyAcurastSignature(bytes32 digest, bytes calldata signature) public view override returns (bool) {
        return ECDSA.recover(_toEthSignedMessageHash(digest), signature) == acurastSigner;
    }

    function _toEthSignedMessageHash(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }
}
