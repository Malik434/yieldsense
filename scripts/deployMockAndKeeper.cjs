"use strict";

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying mock stack with:", deployer.address);

  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const mockToken = await MockUSDC.deploy(6, { gasLimit: 3_000_000 });
  await mockToken.waitForDeployment();
  const mockAddress = await mockToken.getAddress();
  await (await mockToken.mint(hre.ethers.parseUnits("100000", 6))).wait();
  console.log("MockUSDC:", mockAddress);

  const MockAutocompounder = await hre.ethers.getContractFactory("MockAutocompounder");
  const mockComp = await MockAutocompounder.deploy(mockAddress, { gasLimit: 2_000_000 });
  await mockComp.waitForDeployment();
  const mockCompAddress = await mockComp.getAddress();
  console.log("MockAutocompounder:", mockCompAddress);

  const Registry = await hre.ethers.getContractFactory("ExecutorRegistry");
  const registry = await Registry.deploy(deployer.address, { gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("ExecutorRegistry:", registryAddress);

  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    mockAddress,
    deployer.address,
    deployer.address,
    mockCompAddress,
    registryAddress,
    { gasLimit: 5_000_000 }
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("YieldSenseKeeper:", keeperAddress);

  await (await mockComp.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();

  const yieldRole = await registry.YIELD_EXECUTOR();
  const gridRole = await registry.GRID_EXECUTOR();
  await (await registry.registerProcessor(deployer.address, yieldRole, hre.ethers.ZeroHash, hre.ethers.ZeroHash, { gasLimit: 160_000 })).wait();
  await (await registry.registerProcessor(deployer.address, gridRole, hre.ethers.ZeroHash, hre.ethers.ZeroHash, { gasLimit: 160_000 })).wait();

  await (await mockToken.approve(keeperAddress, hre.ethers.MaxUint256, { gasLimit: 100_000 })).wait();

  console.log("\nCopy these into frontend/.env.local:");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${mockAddress}`);
  console.log(`NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS=${mockCompAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
