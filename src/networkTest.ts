async function main() {
  console.log("Acurast Network Test Starting...");

  // 1. Test the Netlify API
  try {
    const res1 = await fetch("https://yieldsense.huzaifamalik.tech/api/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36 YieldSense/1.0",
        "Authorization": "Bearer e10383a7f06075735018c89582bd53f966981ab0a386d35763776f0c490fdc58"
      },
      body: JSON.stringify({ 
        event: "acurast_network_test", 
        message: "Hello from Acurast TEE!",
        userAddress: "0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA" 
      })
    });
    console.log("Netlify Status:", res1.status, res1.statusText);
    const text1 = await res1.text();
    console.log("Netlify Response Payload:", text1.substring(0, 150));
  } catch (e) {
    const error = e as Error;
    console.error("Netlify Fetch Exception:", error.message);
  }

  // 2. Test a generic public API (Postman Echo)
  try {
    const res2 = await fetch("https://postman-echo.com/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Postman Echo works perfectly from Acurast!" })
    });
    console.log("Postman Echo Status:", res2.status, res2.statusText);
  } catch (e) {
    const error = e as Error;
    console.error("Postman Echo Exception:", error.message);
  }

  console.log("Acurast Network Test Complete.");
}

main().catch(console.error);
