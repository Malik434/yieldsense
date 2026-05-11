const { ethers } = require("ethers");

const KEEPER_ADDRESS = "0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF";
const RPC_URL = "https://base.llamarpc.com";

const KEEPER_ABI = [
    "function maxTotalAssets() view returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function owner() view returns (address)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const keeper = new ethers.Contract(KEEPER_ADDRESS, KEEPER_ABI, provider);

    const [maxAssets, totalAssets, owner] = await Promise.all([
        keeper.maxTotalAssets(),
        keeper.totalAssets(),
        keeper.owner()
    ]);

    console.log(`Keeper: ${KEEPER_ADDRESS}`);
    console.log(`Owner:  ${owner}`);
    console.log(`maxTotalAssets: ${maxAssets.toString()} (${ethers.formatUnits(maxAssets, 6)} USDC)`);
    console.log(`totalAssets:    ${totalAssets.toString()} (${ethers.formatUnits(totalAssets, 6)} USDC)`);
}

main().catch(console.error);
