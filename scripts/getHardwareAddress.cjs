const { ethers } = require('ethers');

// Public key from your Acurast identity provided earlier
const publicKey = "0x02e0c643be63a75b66965fb0eef79092f38ddfbfd788206fdc5993579de0d562b9";

try {
  const address = ethers.computeAddress(publicKey);
  console.log("\n--------------------------------------------------");
  console.log("Acurast TEE Ethereum Address:", address);
  console.log("--------------------------------------------------\n");
  console.log("1. Send Base Sepolia ETH to this address for gas.");
  console.log("2. Use this address in scripts/attestProcessor.cjs to whitelist it.");
} catch (e) {
  console.error("Error deriving address:", e.message);
}
