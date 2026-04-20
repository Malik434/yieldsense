const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // 1. Deploy Mock ERC20
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const mockToken = await MockERC20.deploy("Mock Asset", "mASSET", { gasLimit: 3000000 });
  await mockToken.waitForDeployment();
  const mockAddress = await mockToken.getAddress();
  console.log("✅ MockERC20 deployed to:", mockAddress);

  // 2. Deploy YieldSenseKeeper
  // The constructor requires (asset, acurastSigner, yieldSource, counterparty)
  const acurastSigner = process.env.USER_ADDRESS || deployer.address;
  const yieldSource = deployer.address;
  const counterparty = deployer.address;
  
  const YieldSenseKeeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await YieldSenseKeeper.deploy(mockAddress, acurastSigner, yieldSource, counterparty, { gasLimit: 5000000 });
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  
  console.log("✅ YieldSenseKeeper deployed to:", keeperAddress);

  // 3. Approve Keeper to pull funds from Yield Source (Deployer) for Grid Trades
  console.log("Approving Keeper to spend MockERC20 from deployer...");
  const tx = await mockToken.approve(keeperAddress, hre.ethers.MaxUint256, { gasLimit: 100000 });
  await tx.wait();
  console.log("✅ Keeper approved for MockERC20 transfers.");
  
  console.log("\n=========================================");
  console.log("🚀 COPY THESE INTO: frontend/.env.local");
  console.log("=========================================");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${mockAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
