// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev YieldSenseKeeper with replay-safe signature validation.
 * This ECDSA fallback is used until P-384 attestation verification is integrated.
 */
contract YieldSenseKeeper {
    address public owner;
    address public acurastWorker;
    uint256 public lastHarvest;
    mapping(bytes32 => bool) public usedPayload;

    event HarvestExecuted(uint256 timestamp, bytes32 payloadHash, bytes32 r, bytes32 s, uint8 v);

    constructor(address _worker) {
        owner = msg.sender;
        acurastWorker = _worker;
        lastHarvest = block.timestamp; // Fix the 56-year gap
    }

    function executeHarvest(bytes32 payloadHash, bytes32 r, bytes32 s, uint8 v) external {
        require(
            msg.sender == acurastWorker,
            "Unauthorized: Only Acurast TEE can trigger"
        );
        require(!usedPayload[payloadHash], "Replay blocked: payload already used");

        address recovered = ecrecover(payloadHash, v, r, s);
        require(recovered == acurastWorker, "Invalid worker signature");

        usedPayload[payloadHash] = true;
        lastHarvest = block.timestamp;
        emit HarvestExecuted(block.timestamp, payloadHash, r, s, v);
    }
}
