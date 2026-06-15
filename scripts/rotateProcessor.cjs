/**
 * Register or revoke Acurast processor addresses in ExecutorRegistry.
 *
 * Examples:
 *   PROCESSOR_ADDRESS=0x... PROCESSOR_ROLE=YIELD_EXECUTOR ACTION=register npx hardhat run scripts/rotateProcessor.cjs --network baseMainnet
 *   PROCESSOR_ADDRESS=0x... PROCESSOR_ROLE=GRID_EXECUTOR ACTION=revoke npx hardhat run scripts/rotateProcessor.cjs --network baseMainnet
 */

"use strict";

require("dotenv").config();
const hre = require("hardhat");

const REGISTRY_ABI = [
  "function YIELD_EXECUTOR() view returns (bytes32)",
  "function GRID_EXECUTOR() view returns (bytes32)",
  "function MONITOR() view returns (bytes32)",
  "function EMERGENCY_OPERATOR() view returns (bytes32)",
  "function registerProcessor(address processor, bytes32 role, bytes32 deploymentHash, bytes32 codeHash) external",
  "function revokeProcessor(address processor, bytes32 role) external",
  "function isAuthorized(address processor, bytes32 role) view returns (bool)",
  "function owner() view returns (address)",
];

async function resolveRole(registry, roleName) {
  const normalized = (roleName || "GRID_EXECUTOR").toUpperCase();
  if (normalized === "YIELD_EXECUTOR") return registry.YIELD_EXECUTOR();
  if (normalized === "GRID_EXECUTOR") return registry.GRID_EXECUTOR();
  if (normalized === "MONITOR") return registry.MONITOR();
  if (normalized === "EMERGENCY_OPERATOR") return registry.EMERGENCY_OPERATOR();
  throw new Error(`Unsupported PROCESSOR_ROLE=${roleName}`);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const registryAddress = process.env.EXECUTOR_REGISTRY_ADDRESS?.trim() || process.env.NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS?.trim();
  const processorAddress = process.argv[2] || process.env.PROCESSOR_ADDRESS?.trim();
  const action = (process.env.ACTION || "register").toLowerCase();
  const roleName = process.env.PROCESSOR_ROLE || "GRID_EXECUTOR";
  const deploymentHash = process.env.DEPLOYMENT_HASH || hre.ethers.ZeroHash;
  const codeHash = process.env.CODE_HASH || hre.ethers.ZeroHash;

  if (!registryAddress) throw new Error("EXECUTOR_REGISTRY_ADDRESS is required");
  if (!processorAddress) throw new Error("PROCESSOR_ADDRESS is required");

  const registry = await hre.ethers.getContractAt(REGISTRY_ABI, registryAddress, deployer);
  const owner = await registry.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Signer ${deployer.address} is not registry owner ${owner}`);
  }

  const role = await resolveRole(registry, roleName);
  const before = await registry.isAuthorized(processorAddress, role);

  console.log("\nProcessor rotation");
  console.log("Registry :", registryAddress);
  console.log("Processor:", processorAddress);
  console.log("Role     :", roleName);
  console.log("Action   :", action);
  console.log("Before   :", before);

  if (action === "register") {
    const tx = await registry.registerProcessor(processorAddress, role, deploymentHash, codeHash, { gasLimit: 180_000 });
    await tx.wait();
    console.log("Registered tx:", tx.hash);
  } else if (action === "revoke") {
    const tx = await registry.revokeProcessor(processorAddress, role, { gasLimit: 100_000 });
    await tx.wait();
    console.log("Revoked tx:", tx.hash);
  } else {
    throw new Error(`Unsupported ACTION=${action}`);
  }

  const after = await registry.isAuthorized(processorAddress, role);
  console.log("After    :", after);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
