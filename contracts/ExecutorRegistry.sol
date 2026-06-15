// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title ExecutorRegistry
 * @notice Stable authorization layer for short-lived Acurast deployment identities.
 *
 * The protocol should authorize processors through this registry instead of
 * binding vaults or users directly to an Acurast deployment address. During
 * testing the deployer EOA owns this registry; ownership can later be moved to
 * a Safe without changing vault or strategy state.
 */
contract ExecutorRegistry is Ownable2Step {
    bytes32 public constant YIELD_EXECUTOR = keccak256("YIELD_EXECUTOR");
    bytes32 public constant GRID_EXECUTOR = keccak256("GRID_EXECUTOR");
    bytes32 public constant MONITOR = keccak256("MONITOR");
    bytes32 public constant EMERGENCY_OPERATOR =
        keccak256("EMERGENCY_OPERATOR");

    struct Processor {
        bool registered;
        bool active;
        bytes32 deploymentHash;
        bytes32 codeHash;
        uint64 registeredAt;
        uint64 activatedAt;
        uint64 revokedAt;
        uint64 lastHeartbeatAt;
    }

    mapping(bytes32 => mapping(address => Processor)) private _processors;

    event ProcessorRegistered(
        address indexed processor,
        bytes32 indexed role,
        bytes32 deploymentHash,
        bytes32 codeHash
    );
    event ProcessorActivated(address indexed processor, bytes32 indexed role);
    event ProcessorRevoked(address indexed processor, bytes32 indexed role);
    event ProcessorHeartbeat(
        address indexed processor,
        bytes32 indexed role,
        uint256 timestamp
    );

    error InvalidAddress();
    error InvalidRole();
    error ProcessorNotRegistered();
    error ProcessorNotActive();

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
    }

    function isAuthorized(
        address processor,
        bytes32 role
    ) external view returns (bool) {
        return _processors[role][processor].active;
    }

    function getProcessor(
        address processor,
        bytes32 role
    ) external view returns (Processor memory) {
        return _processors[role][processor];
    }

    function registerProcessor(
        address processor,
        bytes32 role,
        bytes32 deploymentHash,
        bytes32 codeHash
    ) external onlyOwner {
        _validateProcessorInput(processor, role);

        Processor storage record = _processors[role][processor];
        record.registered = true;
        record.active = true;
        record.deploymentHash = deploymentHash;
        record.codeHash = codeHash;
        record.registeredAt = uint64(block.timestamp);
        record.activatedAt = uint64(block.timestamp);
        record.revokedAt = 0;

        emit ProcessorRegistered(
            processor,
            role,
            deploymentHash,
            codeHash
        );
        emit ProcessorActivated(processor, role);
    }

    function revokeProcessor(
        address processor,
        bytes32 role
    ) external onlyOwner {
        _validateProcessorInput(processor, role);

        Processor storage record = _processors[role][processor];
        if (!record.registered) revert ProcessorNotRegistered();

        record.active = false;
        record.revokedAt = uint64(block.timestamp);

        emit ProcessorRevoked(processor, role);
    }

    function heartbeat(bytes32 role) external {
        Processor storage record = _processors[role][msg.sender];
        if (!record.registered) revert ProcessorNotRegistered();
        if (!record.active) revert ProcessorNotActive();

        record.lastHeartbeatAt = uint64(block.timestamp);
        emit ProcessorHeartbeat(msg.sender, role, block.timestamp);
    }

    function _validateProcessorInput(
        address processor,
        bytes32 role
    ) internal pure {
        if (processor == address(0)) revert InvalidAddress();
        if (
            role != YIELD_EXECUTOR &&
            role != GRID_EXECUTOR &&
            role != MONITOR &&
            role != EMERGENCY_OPERATOR
        ) revert InvalidRole();
    }
}
