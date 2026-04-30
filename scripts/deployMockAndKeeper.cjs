const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // 1. Deploy MockUSDC with 6 decimals (matching real USDC)
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const mockToken = await MockUSDC.deploy(6, { gasLimit: 3000000 });
  await mockToken.waitForDeployment();
  const mockAddress = await mockToken.getAddress();
  console.log("✅ MockUSDC deployed to:", mockAddress);

  // 2. Deploy YieldSenseKeeper
  // acurastSigner = deployer, since the Hardhat account IS the ACURAST_WORKER_KEY
  const acurastSigner = deployer.address;
  const yieldSource = deployer.address;
  const counterparty = deployer.address;
  
  const YieldSenseKeeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await YieldSenseKeeper.deploy(mockAddress, yieldSource, counterparty, { gasLimit: 5000000 });
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  
  console.log("✅ YieldSenseKeeper deployed to:", keeperAddress);

  // 3. Approve Keeper to pull funds from Yield Source (Deployer) for Grid Trades
  console.log("Approving Keeper to spend MockUSDC from deployer...");
  const tx1 = await mockToken.approve(keeperAddress, hre.ethers.MaxUint256, { gasLimit: 100000 });
  await tx1.wait();
  console.log("✅ Keeper approved for MockUSDC transfers.");

  // 4. Attest the deployer as a trusted TEE processor (for testnet bootstrapping)
  console.log("Attesting deployer as trusted TEE processor...");
  const tx2 = await keeper.ownerAttestProcessor(deployer.address, { gasLimit: 100000 });
  await tx2.wait();
  console.log("✅ Deployer attested as trusted processor.");

  // 5. Set a dummy P-256 attestation root key (for testnet demo)
  // In production, this would be the Acurast network attestation root or Google Titan M root CA
  const dummyQx = "0x" + "a".repeat(64); // Placeholder P-256 x-coordinate
  const dummyQy = "0x" + "b".repeat(64); // Placeholder P-256 y-coordinate
  console.log("Setting P-256 attestation root key...");
  const tx3 = await keeper.setAttestationRoot(dummyQx, dummyQy, { gasLimit: 100000 });
  await tx3.wait();
  console.log("✅ P-256 attestation root key set.");

  console.log("\n=========================================");
  console.log("🚀 COPY THESE INTO: frontend/.env.local");
  console.log("=========================================");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${mockAddress}`);
  console.log("\n--- P-256 TEE Attestation Status ---");
  console.log(`Attestation Root Qx: ${dummyQx}`);
  console.log(`Attestation Root Qy: ${dummyQy}`);
  console.log(`Attested Processors: [${deployer.address}]`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
