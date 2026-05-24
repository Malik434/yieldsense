/**
 * Deploys a full testing stack with ExecutorRegistry.
 *
 * Testnets use MockUSDC + MockAutocompounder. Mainnet-like networks require
 * ASSET_ADDRESS, POOL_ADDRESS, GAUGE_ADDRESS, and REWARD_TOKEN_ADDRESS.
 */

"use strict";

const hre = require("hardhat");

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const POOL_ADDRESS = process.env.POOL_ADDRESS || "";
const GAUGE_ADDRESS = process.env.GAUGE_ADDRESS || "";
const ASSET_ADDRESS = process.env.ASSET_ADDRESS || "";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const isTestnet = [84531n, 84532n, 31337n].includes(network.chainId);

  console.log("\nYieldSense full stack deployer");
  console.log("Deployer:", deployer.address);
  console.log("Network :", network.name, `(chainId: ${network.chainId})`);
  console.log("Mode    :", isTestnet ? "testnet/local" : "mainnet-like");

  console.log("\nDeploying ExecutorRegistry...");
  const Registry = await hre.ethers.getContractFactory("ExecutorRegistry");
  const registry = await Registry.deploy(deployer.address, { gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("ExecutorRegistry:", registryAddress);

  let assetAddress = ASSET_ADDRESS;
  if (!assetAddress) {
    if (!isTestnet) throw new Error("ASSET_ADDRESS must be set for mainnet-like deployments");
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mock = await MockUSDC.deploy(6, { gasLimit: 3_000_000 });
    await mock.waitForDeployment();
    assetAddress = await mock.getAddress();
    await (await mock.mint(hre.ethers.parseUnits("100000", 6))).wait();
    console.log("MockUSDC:", assetAddress);
  } else {
    console.log("Asset:", assetAddress);
  }

  let autocompounderAddress;
  const useMock = isTestnet || !POOL_ADDRESS || !GAUGE_ADDRESS;
  if (useMock) {
    const MockAutocompounder = await hre.ethers.getContractFactory("MockAutocompounder");
    const mockComp = await MockAutocompounder.deploy(assetAddress, { gasLimit: 2_000_000 });
    await mockComp.waitForDeployment();
    autocompounderAddress = await mockComp.getAddress();
    console.log("MockAutocompounder:", autocompounderAddress);
  } else {
    const rewardToken = process.env.REWARD_TOKEN_ADDRESS || "";
    if (!rewardToken) throw new Error("REWARD_TOKEN_ADDRESS must be set");
    const Autocompounder = await hre.ethers.getContractFactory("AerodromeAutocompounder");
    const compounder = await Autocompounder.deploy(
      POOL_ADDRESS,
      GAUGE_ADDRESS,
      assetAddress,
      rewardToken,
      ROUTER_ADDRESS,
      FACTORY_ADDRESS,
      deployer.address,
      { gasLimit: 6_000_000 }
    );
    await compounder.waitForDeployment();
    autocompounderAddress = await compounder.getAddress();
    console.log("AerodromeAutocompounder:", autocompounderAddress);
  }

  const yieldSource = autocompounderAddress;
  const counterparty = deployer.address;
  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    assetAddress,
    yieldSource,
    counterparty,
    autocompounderAddress,
    registryAddress,
    { gasLimit: 6_000_000 }
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("YieldSenseKeeper:", keeperAddress);

  if (!useMock) {
    const compounder = await hre.ethers.getContractAt("AerodromeAutocompounder", autocompounderAddress);
    await (await compounder.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();
    console.log("Autocompounder keeper set.");
  } else {
    const mockComp = await hre.ethers.getContractAt("MockAutocompounder", autocompounderAddress);
    await (await mockComp.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();
  }

  const processorAddress = process.env.PROCESSOR_ADDRESS?.trim() || deployer.address;
  const extraProcessors = (process.env.EXTRA_PROCESSOR_ADDRESSES || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const processors = Array.from(new Set([processorAddress, ...extraProcessors]));
  const yieldRole = await registry.YIELD_EXECUTOR();
  const gridRole = await registry.GRID_EXECUTOR();

  for (const processor of processors) {
    await (await registry.registerProcessor(processor, yieldRole, hre.ethers.ZeroHash, hre.ethers.ZeroHash, { gasLimit: 160_000 })).wait();
    await (await registry.registerProcessor(processor, gridRole, hre.ethers.ZeroHash, hre.ethers.ZeroHash, { gasLimit: 160_000 })).wait();
    console.log("Registered processor:", processor);
  }

  if (isTestnet) {
    const asset = await hre.ethers.getContractAt(
      ["function approve(address,uint256) external returns (bool)"],
      assetAddress
    );
    await (await asset.approve(keeperAddress, hre.ethers.MaxUint256, { gasLimit: 100_000 })).wait();
  }

  console.log("\nCopy to env:");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${assetAddress}`);
  console.log(`NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
  console.log(`KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`ASSET_ADDRESS=${assetAddress}`);
  console.log(`AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
