import { ethers } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// 1. Configuration & Contract ABI
const RPC_URL = "https://sepolia.base.org"; 
const KEEPER_ADDRESS = "0x2BA7c3a0aeD57e13fbaf203C51CD700c8d666137";
// Target Pool: WETH/USDC (Aerodrome)
const POOL_ADDRESS = "0xd0b53D9277642d899DF5C87A3966A349A798F224"; 
const STRATEGY_TVL = 10000; // $10,000 (V)
const EFFICIENCY_MULTIPLIER = 1.5; // (μ)
const POOL_FEE = 0.003; // 0.3% (φ)

const KEEPER_ABI = [
    "function lastHarvest() view returns (uint256)",
    "function executeHarvest(bytes32 r, bytes32 s) external" // Added parameters to match the call
];

async function getAPR(poolAddress: string): Promise<number> {
    const addr = poolAddress.toLowerCase();
    const stealthHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YieldSense/2.0' };
    
    console.log("🔍 Fetching Multi-Source APR Consensus...");

    const results = await Promise.allSettled([
        // Source 1: GeckoTerminal (Volume/Liquidity for Calculation)
        axios.get(`https://api.geckoterminal.com/api/v2/networks/base/pools/${addr}`, { headers: stealthHeaders, timeout: 5000 }),

        // Source 2: DexScreener (Alternative Volume/Fee check)
        axios.get(`https://api.dexscreener.com/latest/dex/pairs/base/${addr}`, { headers: stealthHeaders, timeout: 5000 }),

        // Source 3: DefiLlama (Yield Search by Address)
        axios.get(`https://yields.llama.fi/pools`, { headers: stealthHeaders, timeout: 12000 })
    ]);

    const yieldOptions: number[] = [];

    // --- Process GeckoTerminal ---
    if (results[0].status === 'fulfilled') {
        const attr = results[0].value.data.data.attributes;
        // If it's Aerodrome, it might have a direct APR
        if (attr.apr_7d || attr.apr) {
            yieldOptions.push(parseFloat(attr.apr_7d || attr.apr) / 100);
        } else {
            // For Uniswap V3: Calculate Estimated APR: (Vol24h * Fee) / TVL * 365
            const vol24h = parseFloat(attr.volume_usd.h24 || "0");
            const tvl = parseFloat(attr.reserve_in_usd || "1");
            const fee = parseFloat(attr.pool_fee_percentage || "0.05") / 100;
            const estimatedAPR = (vol24h * fee) / tvl * 365;
            if (estimatedAPR > 0) yieldOptions.push(estimatedAPR);
        }
    }

    // --- Process DexScreener ---
    if (results[1].status === 'fulfilled') {
        const pair = results[1].value.data.pairs?.[0];
        if (pair?.apr) {
            yieldOptions.push(pair.apr / 100);
        } else if (pair?.volume?.h24 && pair?.liquidity?.usd) {
            // Fallback calculation for Uniswap on DexScreener
            const est = (pair.volume.h24 * 0.0005) / pair.liquidity.usd * 365;
            if (est > 0) yieldOptions.push(est);
        }
    }

    // --- Process DefiLlama ---
    if (results[2].status === 'fulfilled') {
        const pool = results[2].value.data.data.find((p: any) => p.pool.toLowerCase() === addr);
        if (pool?.apy) yieldOptions.push(pool.apy / 100);
    }

    // --- Final Decision ---
    if (yieldOptions.length > 0) {
        const finalAPR = yieldOptions.reduce((a, b) => a + b, 0) / yieldOptions.length;
        console.log(`✅ SUCCESS: Derived Consensus APR: ${(finalAPR * 100).toFixed(2)}%`);
        return finalAPR;
    }

    console.warn("⚠️ All Sources empty. Using 32% fallback.");
    return 0.32;
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
        getAPR(POOL_ADDRESS),
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