import { ethers } from 'ethers';
import axios from 'axios';

// 1. Configuration & Contract ABI
const RPC_URL = "https://sepolia.base.org"; 
const KEEPER_ADDRESS = "0x2BA7c3a0aeD57e13fbaf203C51CD700c8d666137";
// Target Pool: WETH/USDC (Aerodrome)
const POOL_ADDRESS = "0xcf77a3ba962d46dcb4d0921037f657d22403b7df"; 
const STRATEGY_TVL = 10000; // $10,000 (V)
const EFFICIENCY_MULTIPLIER = 1.5; // (μ)
const POOL_FEE = 0.003; // 0.3% (φ)

const KEEPER_ABI = [
    "function lastHarvest() view returns (uint256)",
    "function executeHarvest() external"
];

// 2. Optimized Data Fetching (Resolved APR Fetch)
async function getAerodromeAPR(poolAddress: string): Promise<number> {
    const poolAddrLower = poolAddress.toLowerCase();
    
    // Primary Source: Aerodrome Native API (2026 MetaDEX Standard)
    try {
        const response = await axios.get(`https://api.aerodrome.finance/v2/pools`);
        const poolData = response.data.data.find((p: any) => p.address.toLowerCase() === poolAddrLower);
        if (poolData && poolData.apr) {
            return parseFloat(poolData.apr) / 100;
        }
    } catch (e) {
        console.warn("Aerodrome Native API unreachable, switching to DefiLlama...");
    }

    // Fallback Source: DefiLlama Yields API (Highly Resilient)
    try {
        const response = await axios.get('https://yields.llama.fi/pools');
        // Filter for Aerodrome on Base
        const pool = response.data.data.find((p: any) => 
            p.project === 'aerodrome' && 
            p.chain === 'Base' && 
            p.pool.toLowerCase() === poolAddrLower
        );
        return pool ? pool.apy / 100 : 0.40; // Default to 40% if not found
    } catch (error) {
        console.error("All yield sources failed. Using safety fallback.");
        return 0.40; // Strict safety fallback
    }
}

async function getEthPrice(): Promise<number> {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        return response.data.ethereum.usd;
    } catch (error) {
        return 3500; // Fallback price
    }
}

// 3. Main Logic Execution
async function checkProfitability() {
    console.log("--- YieldSense Logic Check: Start ---");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const keeperContract = new ethers.Contract(KEEPER_ADDRESS, KEEPER_ABI, provider);

    const [ethPrice, currentAPR, lastHarvest, feeData] = await Promise.all([
        getEthPrice(),
        getAerodromeAPR(POOL_ADDRESS),
        keeperContract.lastHarvest(),
        provider.getFeeData()
    ]);

    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceLast = currentTime - Number(lastHarvest);
    
    const gasPrice = feeData.gasPrice || BigInt(0);
    const estGasUnits = BigInt(200000); 
    const gasCostUSD = parseFloat(ethers.formatEther(gasPrice * estGasUnits)) * ethPrice;

    // Formula: (V * r * t) / secondsInYear
    const secondsInYear = 31536000;
    const accumulatedReward = (STRATEGY_TVL * currentAPR * timeSinceLast) / secondsInYear;
    const netReward = accumulatedReward * (1 - POOL_FEE);

    console.log(`Pool APR: ${(currentAPR * 100).toFixed(2)}% | Last Harvest: ${timeSinceLast}s ago`);
    console.log(`Net Reward: $${netReward.toFixed(4)} | Gas Cost: $${gasCostUSD.toFixed(4)}`);

    if (netReward > (gasCostUSD * EFFICIENCY_MULTIPLIER)) {
        console.log("✅ SUCCESS: Profitability threshold met.");
        
        // --- NEW: TRIGGER LOGIC ---
        try {
            // In Acurast, the PRIVATE_KEY is provided as a secure environment variable
            const privateKey = process.env.ACURAST_WORKER_KEY;
            if (!privateKey) throw new Error("Worker Key missing in environment");

            const wallet = new ethers.Wallet(privateKey, provider);
            const signedKeeper = new ethers.Contract(KEEPER_ADDRESS, KEEPER_ABI, wallet);

            // Phase 3 Placeholder: Sending random r/s for now
            // We will replace this with real P-384 signature generation in the next step
            const dummyR = ethers.randomBytes(32);
            const dummyS = ethers.randomBytes(32);

            console.log("Broadcasting harvest to Base Sepolia...");
            const tx = await signedKeeper.executeHarvest(dummyR, dummyS);
            console.log(`🚀 Transaction Sent! Hash: ${tx.hash}`);
            
            await tx.wait();
            console.log("🏁 Harvest transaction confirmed on-chain.");
        } catch (error: any) {
            console.error("Failed to trigger harvest:", error.message);
        }
        // --------------------------
        
    } else {
        console.log("❌ WAIT: Compounding not yet profitable.");
    }
}

checkProfitability();