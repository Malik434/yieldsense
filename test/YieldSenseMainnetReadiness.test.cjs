const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("YieldSense Mainnet Readiness — Audit & Security Fixes", function () {
  this.timeout(120_000);

  let keeper, autocompounder, usdc, rewardToken;
  let owner, alice, bob, feeRecipient;
  let signer;

  beforeEach(async function () {
    [owner, alice, bob, feeRecipient] = await ethers.getSigners();
    signer = ethers.Wallet.createRandom().connect(ethers.provider);

    // Deploy Mock USDC (6 decimals)
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy(6);
    await usdc.waitForDeployment();

    // Deploy Mock Reward Token (AERO)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    rewardToken = await MockERC20.deploy("Aerodrome", "AERO");
    await rewardToken.waitForDeployment();

    // Deploy Mock Autocompounder
    const MockAutocompounder = await ethers.getContractFactory("MockAutocompounder");
    autocompounder = await MockAutocompounder.deploy(await usdc.getAddress());
    await autocompounder.waitForDeployment();

    // Deploy YieldSenseKeeper
    const KeeperFactory = await ethers.getContractFactory("YieldSenseKeeper");
    keeper = await KeeperFactory.deploy(
      await usdc.getAddress(),
      owner.address, // dummy yieldSource
      owner.address, // dummy counterparty
      await autocompounder.getAddress()
    );
    await keeper.waitForDeployment();

    // Setup: set keeper in autocompounder
    await autocompounder.setKeeper(await keeper.getAddress());

    // Attest the signer for harvest tests
    await keeper.setAttestationRoot(ethers.ZeroHash, ethers.ZeroHash); // not used in ownerAttest
    // Wait, I removed ownerAttestProcessor and added a timelocked "processor" update
    // Let's use the timelock to attest the signer
    const key = ethers.encodeBytes32String("processor");
    await keeper.initiateUpdate(key, signer.address);
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600 + 1]);
    await ethers.provider.send("evm_mine");
    await keeper.applyUpdate(key);
  });

  async function getSignature(payloadHash) {
    const rawSig = await signer.signMessage(ethers.getBytes(payloadHash));
    const { r, s, v } = ethers.Signature.from(rawSig);
    return { r, s, v };
  }

  // 1. Share Accounting Integrity
  it("Scenario 1: Share Accounting Integrity (Alice -> Profit -> Bob -> Alice Withdraw)", async function () {
    const depositAlice = ethers.parseUnits("1000", 6);
    await usdc.mintTo(alice.address, depositAlice);
    await usdc.connect(alice).approve(await keeper.getAddress(), depositAlice);

    // Alice deposits
    await keeper.connect(alice).deposit(depositAlice, alice.address);
    expect(await keeper.balanceOf(alice.address)).to.equal(depositAlice);

    // Deploy to pool
    await keeper.deployToPool(depositAlice, 0);
    expect(await usdc.balanceOf(await keeper.getAddress())).to.equal(0);
    expect(await keeper.totalAssets()).to.equal(depositAlice);

    // Strategy compounds (simulated by seeding the autocompounder with profit)
    const profit = ethers.parseUnits("200", 6);
    await usdc.mintTo(owner.address, profit);
    await usdc.connect(owner).approve(await autocompounder.getAddress(), profit);
    await autocompounder.seed(profit);

    // Total assets should now be 1200
    expect(await keeper.totalAssets()).to.equal(depositAlice + profit);

    // Bob deposits 1000 USDC
    const depositBob = ethers.parseUnits("1000", 6);
    await usdc.mintTo(bob.address, depositBob);
    await usdc.connect(bob).approve(await keeper.getAddress(), depositBob);

    // Bob's shares should be diluted compared to Alice's
    // Price = 1200 / 1000 = 1.2
    // Bob should get 1000 / 1.2 = 833.33 shares
    await keeper.connect(bob).deposit(depositBob, bob.address);
    const bobShares = await keeper.balanceOf(bob.address);
    expect(bobShares).to.be.lessThan(depositBob);
    expect(bobShares).to.be.closeTo(ethers.parseUnits("833.333333", 6), 1000);

    // Alice withdraws her shares
    // Total assets = 1200 + 1000 = 2200
    // Total shares = 1000 + 833.33 = 1833.33
    // Alice's 1000 shares are worth 1000 * (2200 / 1833.33) = 1200
    await ethers.provider.send("evm_mine"); // Move past flash loan block protection
    const aliceBalanceBefore = await usdc.balanceOf(alice.address);
    
    // Keeper must unwind LP first so Alice can withdraw (since idle USDC is only 1000 from Bob, and she needs 1200)
    // Actually Alice needs 1200, Bob's deposit is 1000. 200 needed from pool.
    await keeper.withdrawFromPool(ethers.parseUnits("200", 6));
    
    const maxAlice = await keeper.maxWithdraw(alice.address);
    await keeper.connect(alice).withdraw(maxAlice, alice.address, alice.address);
    // Expect approximately 1200 (within rounding)
    expect(await usdc.balanceOf(alice.address)).to.be.closeTo(aliceBalanceBefore + ethers.parseUnits("1200", 6), 10);
  });

  // 2. Full Withdrawal Lifecycle
  it("Scenario 2: Full Withdrawal Lifecycle (MaxWithdraw capped by idle balance)", async function () {
    const depositAmount = ethers.parseUnits("1000", 6);
    await usdc.mintTo(alice.address, depositAmount);
    await usdc.connect(alice).approve(await keeper.getAddress(), depositAmount);
    await keeper.connect(alice).deposit(depositAmount, alice.address);

    // Deploy all to pool
    await keeper.deployToPool(depositAmount, 0);
    
    // maxWithdraw should be 0 because idle USDC is 0
    expect(await keeper.maxWithdraw(alice.address)).to.equal(0);
    
    // Try to withdraw -> should fail (ERC4626 default logic or our override)
    await expect(keeper.connect(alice).withdraw(depositAmount, alice.address, alice.address))
      .to.be.reverted;

    // Keeper unwinds some LP
    await keeper.withdrawFromPool(ethers.parseUnits("500", 6));
    
    // Now maxWithdraw should be 500
    expect(await keeper.maxWithdraw(alice.address)).to.equal(ethers.parseUnits("500", 6));
    
    // Alice withdraws 500
    await ethers.provider.send("evm_mine");
    await keeper.connect(alice).withdraw(ethers.parseUnits("500", 6), alice.address, alice.address);
    expect(await usdc.balanceOf(alice.address)).to.equal(ethers.parseUnits("500", 6));
  });

  // 3. Flash Loan Attack Simulation
  it("Scenario 3: Flash Loan Attack Simulation (Same block protection)", async function () {
    const depositAmount = ethers.parseUnits("1000", 6);
    await usdc.mintTo(alice.address, depositAmount);
    await usdc.connect(alice).approve(await keeper.getAddress(), depositAmount);

    // Disable auto-mining to simulate a single block
    await ethers.provider.send("evm_setAutomine", [false]);
    
    const tx1 = await keeper.connect(alice).deposit(depositAmount, alice.address);
    const tx2 = await keeper.connect(alice).withdraw(depositAmount, alice.address, alice.address);
    
    await ethers.provider.send("evm_mine");
    await ethers.provider.send("evm_setAutomine", [true]);

    const receipt1 = await tx1.wait();
    expect(receipt1.status).to.equal(1);
    
    // tx2 should have failed because it was in the same block as tx1
    try {
        await tx2.wait();
        expect.fail("Withdraw should have failed in the same block as deposit");
    } catch (error) {
        expect(error.code).to.equal("CALL_EXCEPTION");
    }
  });

  // 4. Dust NAV Accuracy
  it("Scenario 4: Dust NAV Accuracy", async function () {
    const depositAmount = ethers.parseUnits("1000", 6);
    await usdc.mintTo(alice.address, depositAmount);
    await usdc.connect(alice).approve(await keeper.getAddress(), depositAmount);
    await keeper.connect(alice).deposit(depositAmount, alice.address);

    // Deploy to pool
    await keeper.deployToPool(depositAmount, 0);

    // Manually add some "dust" to autocompounder (e.g. random USDC transfer)
    const dust = ethers.parseUnits("5", 6);
    await usdc.mintTo(owner.address, dust);
    await usdc.connect(owner).transfer(await autocompounder.getAddress(), dust);

    // totalAssets should include the dust (1000 + 5)
    expect(await keeper.totalAssets()).to.equal(depositAmount + dust);
  });

  // 5. Route Validation Failure Cases
  it("Scenario 5: Route Validation Failure Cases", async function () {
    const payloadHash = ethers.keccak256(ethers.toUtf8Bytes("harvest-payload"));
    const { r, s, v } = await getSignature(payloadHash);
    
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 300;

    // A: Empty routes
    await expect(keeper.executeHarvest(1, await autocompounder.getAddress(), r, s, v, 0, 0, deadline, []))
      .to.be.revertedWith("Empty routes");

    // B: Expired deadline
    await expect(keeper.executeHarvest(2, await autocompounder.getAddress(), r, s, v, 0, 0, deadline - 7200, [{from: await usdc.getAddress(), to: await usdc.getAddress(), stable: false, factory: owner.address}]))
      .to.be.revertedWith("Stale quote");
      
    // Note: the "wrong token start" check is in the Autocompounder logic which we mocked.
    // In our implementation of harvestAndCompound in MockAutocompounder, we don't check routes[0].from.
    // But we can verify it fails if we added it.
  });
});
