/**
 * attestProcessor.cjs
 *
 * Attests an Acurast processor address on the deployed YieldSenseKeeper so it
 * can pass the ProcessorNotAttested gate in executeTrade and executeHarvest.
 *
 * This script uses ownerAttestProcessor() — the admin bypass path used while the
 * permissionless P-256 TEE attestation flow (attestProcessor with live Acurast CA
 * cert chain) is being integrated. It should be replaced by permissionless
 * attestation once the Acurast CA root key is configured via setAttestationRoot().
 *
 * Usage:
 *   npx hardhat run scripts/attestProcessor.cjs --network baseSepolia
 *
 * Required env vars:
 *   KEEPER_ADDRESS      — deployed YieldSenseKeeper contract address
 *   ACURAST_WORKER_KEY  — private key of the contract owner (deployer)
 *
 * Optional:
 *   PROCESSOR_ADDRESS   — address to attest (defaults to auto-discovery then deployer)
 *   FRONTEND_URL        — frontend URL for auto-discovering hw_address_report telemetry
 */

require("dotenv").config();
const hre = require("hardhat");

const KEEPER_ABI = [
  "function ownerAttestProcessor(address processor) external",
  "function attestedProcessors(address) external view returns (bool)",
  "function owner() external view returns (address)",
];

/**
 * Fetch the latest hw_address_report from the Netlify telemetry store.
 * Returns null if unreachable or not found.
 */
async function fetchLatestHwAddress(frontendUrl) {
  try {
    const url = frontendUrl.replace(/\/$/, "") + "/api/state";
    const fetchFn = globalThis.fetch
      ?? (await import("node-fetch").then(m => m.default).catch(() => null));

    if (!fetchFn) {
      console.warn("  fetch unavailable — skipping auto-discovery");
      return null;
    }

    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
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

  // Processor address resolution order:
  //  1. PROCESSOR_ADDRESS env var (explicit)
  //  2. Latest hw_address_report from Netlify telemetry (auto-discovery)
  //  3. Deployer address (local / fallback)
  let processorAddress = process.env.PROCESSOR_ADDRESS?.trim();

  if (!processorAddress) {
    const frontendUrl = process.env.FRONTEND_URL || "https://yieldsense.huzaifamalik.tech";
    console.log(`  No PROCESSOR_ADDRESS — querying ${frontendUrl} for hw_address_report…`);
    processorAddress = await fetchLatestHwAddress(frontendUrl);
    if (processorAddress) {
      console.log(`  Auto-discovered: ${processorAddress}`);
    } else {
      console.log("  hw_address_report not found — falling back to deployer address");
      processorAddress = deployer.address;
    }
  }

  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║        YieldSense — ownerAttestProcessor           ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log(`  Network  : ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Keeper   : ${keeperAddress}`);
  console.log(`  Processor: ${processorAddress}\n`);

  const keeper = await hre.ethers.getContractAt(KEEPER_ABI, keeperAddress, deployer);

  // Verify caller is owner
  const owner = await keeper.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is not the keeper owner (${owner}). ` +
      `Set ACURAST_WORKER_KEY to the owner private key.`
    );
  }

  // Skip if already attested
  const alreadyAttested = await keeper.attestedProcessors(processorAddress);
  if (alreadyAttested) {
    console.log(`✔  ${processorAddress} is already attested — no action needed.`);
    console.log("\n✅ Done.\n");
    return;
  }

  console.log(`Attesting processor ${processorAddress}…`);
  const tx = await keeper.ownerAttestProcessor(processorAddress, { gasLimit: 100_000 });
  await tx.wait();
  console.log(`✅ Attested — tx: ${tx.hash}`);
  console.log(
    "\nNext step: the user must call assignProcessor(processorAddress) from their wallet" +
    "\nto bind this processor to their account before executeTrade will accept its signatures.\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
