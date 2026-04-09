import axios from 'axios';

// The pool address you provided from Chrome (Uniswap USDC/WETH)
const POOL_ADDRESS = "0xd0b53d9277642d899df5c87a3966a349a798f224"; 

const stealthHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.geckoterminal.com/'
};

async function testSource(name: string, url: string) {
    console.log(`\n--- Testing ${name} ---`);
    console.log(`URL: ${url}`);
    try {
        const start = Date.now();
        const res = await axios.get(url, { headers: stealthHeaders, timeout: 10000 });
        const duration = Date.now() - start;
        
        console.log(`✅ Success (${duration}ms)`);
        console.log(`Status: ${res.status}`);
        
        // Print a snippet of the data to verify structure
        const dataStr = JSON.stringify(res.data).substring(0, 200);
        console.log(`Data Snippet: ${dataStr}...`);
        
        return res.data;
    } catch (error: any) {
        console.log(`❌ FAILED`);
        if (error.response) {
            console.log(`Status: ${error.response.status}`);
            console.log(`Reason: ${error.response.statusText}`);
            if (error.response.status === 403) {
                console.log("👉 Cloudflare Blocked you. This is why the script gets 'No Data'.");
            }
        } else {
            console.log(`Error Code: ${error.code}`);
        }
    }
}

async function runDiagnostics() {
    // 1. Test GeckoTerminal
    await testSource("GeckoTerminal", `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL_ADDRESS}`);

    // 2. Test DexScreener
    await testSource("DexScreener", `https://api.dexscreener.com/latest/dex/pairs/base/${POOL_ADDRESS}`);

    // 3. Test DefiLlama
    await testSource("DefiLlama", `https://yields.llama.fi/pools`);

    // 4. Test Aerodrome (Note: This specific pool is Uniswap, so Aerodrome will 404)
    await testSource("Aerodrome", `https://api.aerodrome.finance/v1/public/yields`);
}

runDiagnostics();