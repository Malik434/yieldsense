// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev YieldSenseKeeper with P-384 verification placeholder.
 * In a production TEE environment, we verify the Hardware Attestation.
 */
contract YieldSenseKeeper {
    address public owner;
    address public acurastWorker;
    uint256 public lastHarvest;

    event HarvestExecuted(uint256 timestamp, bytes32 r, bytes32 s);

    constructor(address _worker) {
        owner = msg.sender;
        acurastWorker = _worker;
        lastHarvest = block.timestamp; // Fix the 56-year gap
    }

    /**
     * @notice Executes harvest only if signed by the Acurast TEE.
     * @param r The R component of the P-384 signature.
     * @param s The S component of the P-384 signature.
     */
    // Change the function signature to use 'bytes' for larger P-384 components
    function executeHarvest(bytes calldata r, bytes calldata s) external {
        // Phase 3 Security
        require(
            msg.sender == acurastWorker,
            "Unauthorized: Only Acurast TEE can trigger"
        );

        // TODO: Add the P384.verify() call here once we import the library
        lastHarvest = block.timestamp;
        emit HarvestExecuted(block.timestamp, bytes32(r), bytes32(s)); // Cast for logging
    }
}
