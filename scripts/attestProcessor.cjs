/**
 * attestProcessor.cjs
 *
 * Calls ownerAttestProcessor(workerAddress) on the deployed YieldSenseKeeper
 * so the Acurast worker's secp256k1 address can pass the ProcessorNotAttested gate.
 *
 * Also optionally sets the primaryUser for harvest profit attribution.
 *
 * Usage:
 *   npx hardhat run scripts/attestProcessor.cjs --network baseSepolia
 *
 * Required env vars (from .env or shell):
 *   KEEPER_ADDRESS     — deployed YieldSenseKeeper address
 *   ACURAST_WORKER_KEY — private key of the contract owner (deployer)
 *
 * Optional:
 *   PROCESSOR_ADDRESS  — override which address to attest
 *                        (defaults to the Ethereum address derived from ACURAST_WORKER_KEY)
 *   PRIMARY_USER       — address to set as vault primaryUser (defaults to PROCESSOR_ADDRESS)
 */

require("dotenv").config();
const hre = require("hardhat");

const KEEPER_ABI = [
  "function ownerAttestProcessor(address processor) external",
  "function setPrimaryUser(address user) external",
  "function attestedProcessors(address) external view returns (bool)",
  "function primaryUser() external view returns (address)",
  "function owner() external view returns (address)",
];

/** Fetch the latest hw_address_report from the Netlify telemetry store. */
async function fetchLatestHwAddress(frontendUrl) {
  try {
    const url = frontendUrl.replace(/\/$/, "") + "/api/state";
    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const res = await (fetch || globalThis.fetch)(url, { timeout: 5000 });
    const data = await res.json();
    const logs = data.logs ?? [];
    const report = logs.find(l => l.event === "hw_address_report" && l.hwAddress);
    return report?.hwAddress ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  const keeperAddress = process.env.KEEPER_ADDRESS?.trim();
  if (!keeperAddress) throw new Error("KEEPER_ADDRESS env var is required");

  // Resolution order for the processor address to attest:
  //   1. PROCESSOR_ADDRESS env var (explicit override)
  //   2. Latest hw_address_report from the Netlify telemetry API (auto-discovery)
  //   3. Deployer address (local dev / testnet fallback)
  let processorAddress = process.env.PROCESSOR_ADDRESS?.trim();
  if (!processorAddress) {
    const frontendUrl = process.env.FRONTEND_URL || "https://yieldsense.huzaifamalik.tech";
    console.log(`  No PROCESSOR_ADDRESS — fetching latest hw_address_report from ${frontendUrl} ...`);
    processorAddress = await fetchLatestHwAddress(frontendUrl);
    if (processorAddress) {
      console.log(`  Auto-discovered processor address: ${processorAddress}`);
    } else {
      console.log("  No hw_address_report found in telemetry — falling back to deployer address.");
      processorAddress = deployer.address;
    }
  }
  const primaryUser = process.env.PRIMARY_USER?.trim() || deployer.address;

  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║           YieldSense — Attest Processor            ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log(`  Network  : ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Keeper   : ${keeperAddress}`);
  console.log(`  Processor: ${processorAddress}`);
  console.log(`  PrimUser : ${primaryUser}\n`);

  const keeper = await hre.ethers.getContractAt(KEEPER_ABI, keeperAddress, deployer);

  // Verify caller is owner
  const owner = await keeper.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is not the keeper owner (${owner}). ` +
      `Set ACURAST_WORKER_KEY to the owner's private key.`
    );
  }

  // Check current attestation state
  const alreadyAttested = await keeper.attestedProcessors(processorAddress);
  if (alreadyAttested) {
    console.log(`✔  ${processorAddress} is already attested — skipping ownerAttestProcessor call.`);
  } else {
    console.log(`Attesting processor ${processorAddress}...`);
    const tx = await keeper.ownerAttestProcessor(processorAddress, { gasLimit: 100_000 });
    await tx.wait();
    console.log(`✅ Attested — tx: ${tx.hash}`);
  }

  // Set primaryUser
  const currentPrimary = await keeper.primaryUser();
  if (currentPrimary.toLowerCase() === primaryUser.toLowerCase()) {
    console.log(`✔  primaryUser already set to ${primaryUser} — skipping.`);
  } else {
    console.log(`Setting primaryUser to ${primaryUser}...`);
    const tx2 = await keeper.setPrimaryUser(primaryUser, { gasLimit: 100_000 });
    await tx2.wait();
    console.log(`✅ primaryUser set — tx: ${tx2.hash}`);
  }

  console.log("\n✅ Done. The Acurast worker can now submit executeHarvest and executeTrade calls.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
