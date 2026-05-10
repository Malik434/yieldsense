const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Mainnet Fork Integration & Security Tests", function () {
    let deployer, keeper, user1, user2, attacker;
    let yieldSenseKeeper, autocompounder;
    let asset, rewardToken, router, factory;

    const BASE_MAINNET_RPC = process.env.BASE_MAINNET_RPC || "https://mainnet.base.org";

    // Base Mainnet Addresses
    const USDC_ADDRESS = ethers.getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // Base USDC
    const AERO_ADDRESS = ethers.getAddress("0x940181a94a35a4569e4529a3cdfb74e38fd98631"); // Base AERO
    const ROUTER_ADDRESS = ethers.getAddress("0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43");
    const FACTORY_ADDRESS = ethers.getAddress("0x420dd381b31aef6683db6b902084cb0ffece40da");
    const GAUGE_ADDRESS = ethers.getAddress("0x4f09bab2f0e15e2a078a227fe1537665f55b8360"); // Live vAMM-USDC/AERO Gauge
    const WHALE_USDC = ethers.getAddress("0x8c128dba2cb66399341aa877315be1054bebaa5e"); // Binance 14 on Base
    const POOL_ADDRESS = ethers.getAddress("0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d"); // vAMM-USDC/AERO pool

    let snapshotId;

    before(async function () {
        if (!process.env.BASE_MAINNET_RPC) {
            console.warn("Skipping Mainnet Fork tests: BASE_MAINNET_RPC not set");
            this.skip();
        }

        // Fork is now configured in hardhat.config.cjs (chainId 8453, blockNumber 45783135).
        // No hardhat_reset needed here.

        [deployer, keeper, user1, user2, attacker] = await ethers.getSigners();

        asset = await ethers.getContractAt("IERC20", USDC_ADDRESS);
        rewardToken = await ethers.getContractAt("IERC20", AERO_ADDRESS);

        // Directly write USDC balances via storage slot manipulation.
        // Circle USDC on Base stores balances at mapping slot 9.
        // This is block-independent and avoids fragile whale impersonation.
        const USDC_BALANCE_SLOT = 9;
        const fundAmount = ethers.parseUnits("10000", 6);

        async function setUsdcBalance(address, amount) {
            const slot = ethers.solidityPackedKeccak256(
                ["uint256", "uint256"],
                [address, USDC_BALANCE_SLOT]
            );
            const paddedAmount = ethers.toBeHex(amount, 32);
            await network.provider.send("hardhat_setStorageAt", [USDC_ADDRESS, slot, paddedAmount]);
        }

        await setUsdcBalance(user1.address, fundAmount);
        await setUsdcBalance(user2.address, fundAmount);
        await setUsdcBalance(attacker.address, fundAmount);

        // Deploy Autocompounder
        // constructor(pool_, gauge_, asset_, rewardToken_, router_, factory_, keeper_)
        const Autocompounder = await ethers.getContractFactory("AerodromeAutocompounder");
        autocompounder = await Autocompounder.deploy(
            POOL_ADDRESS,
            GAUGE_ADDRESS,
            USDC_ADDRESS,
            AERO_ADDRESS,
            ROUTER_ADDRESS,
            FACTORY_ADDRESS,
            keeper.address
        );

        // Deploy Keeper
        const Keeper = await ethers.getContractFactory("YieldSenseKeeper");
        yieldSenseKeeper = await Keeper.deploy(USDC_ADDRESS, AERO_ADDRESS, keeper.address, await autocompounder.getAddress());

        // Setup permissions
        await autocompounder.setKeeper(await yieldSenseKeeper.getAddress());

        // Attest keeper via timelock
        const processorKey = ethers.encodeBytes32String("processor");
        await yieldSenseKeeper.connect(deployer).initiateUpdate(processorKey, keeper.address);
        await network.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1]);
        await network.provider.send("evm_mine");
        await yieldSenseKeeper.connect(deployer).applyUpdate(processorKey);

        // Approvals
        await asset.connect(user1).approve(await yieldSenseKeeper.getAddress(), ethers.MaxUint256);
        await asset.connect(user2).approve(await yieldSenseKeeper.getAddress(), ethers.MaxUint256);
        await asset.connect(attacker).approve(await yieldSenseKeeper.getAddress(), ethers.MaxUint256);

        // Set a generous deposit cap for fork tests (default is 0 = disabled).
        // In production the Safe sets this explicitly after accepting ownership.
        await yieldSenseKeeper.connect(deployer).setMaxTotalAssets(ethers.parseUnits("100000", 6));
    });

    beforeEach(async function () {
        snapshotId = await network.provider.send("evm_snapshot");
    });

    afterEach(async function () {
        await network.provider.send("evm_revert", [snapshotId]);
    });

    // Helper for EIP-712 Signature
    async function signPayload(nonce, targetPool, minLpOut, amountToSwap, deadline, routes, signer) {
        const domain = {
            name: "YieldSense",
            version: "1",
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: ethers.getAddress(await yieldSenseKeeper.getAddress())
        };
        const types = {
            HarvestPayload: [
                { name: "keeper", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "targetPool", type: "address" },
                { name: "minLpOut", type: "uint256" },
                { name: "amountToSwap", type: "uint256" },
                { name: "deadline", type: "uint256" },
                { name: "routes", type: "Route[]" }
            ],
            Route: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "stable", type: "bool" },
                { name: "factory", type: "address" }
            ]
        };

        const value = {
            keeper: ethers.getAddress(signer.address),
            nonce: nonce,
            targetPool: ethers.getAddress(targetPool),
            minLpOut: minLpOut,
            amountToSwap: amountToSwap,
            deadline: deadline,
            routes: routes.map(r => ({
                from: ethers.getAddress(r.from),
                to: ethers.getAddress(r.to),
                stable: r.stable,
                factory: ethers.getAddress(r.factory)
            }))
        };

        const signature = await signer.signTypedData(domain, types, value);
        return ethers.Signature.from(signature);
    }

    it("Replay Attack Test: should revert if nonce is reused", async function () {
        const nonce = 1;
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 240;
        const routes = [{ from: AERO_ADDRESS, to: USDC_ADDRESS, stable: false, factory: FACTORY_ADDRESS }];

        // targetPool must be the actual LP pool address, not the autocompounder contract
        const sig = await signPayload(nonce, POOL_ADDRESS, 0, 0, deadline, routes, keeper);

        // First execution should succeed
        const tx = await yieldSenseKeeper.connect(keeper).executeHarvest(
            nonce, POOL_ADDRESS, sig.r, sig.s, sig.v, 0, 0, deadline, routes
        );
        const receipt = await tx.wait();

        // Second execution should fail
        await expect(
            yieldSenseKeeper.connect(keeper).executeHarvest(
                nonce, POOL_ADDRESS, sig.r, sig.s, sig.v, 0, 0, deadline, routes
            )
        ).to.be.revertedWithCustomError(yieldSenseKeeper, "NonceAlreadyUsed");
    });

    it("Malformed Route Test: should cleanly revert on tampered payload", async function () {
        const nonce = 2;
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 300;
        const validRoutes = [{ from: AERO_ADDRESS, to: USDC_ADDRESS, stable: false, factory: FACTORY_ADDRESS }];
        // Tampered: stable flag changed — signature will not match, but route validation
        // fires first (before sig check), so we expect InvalidRouteFactory or ProcessorNotAttested.
        // The correct targetPool must be passed so route pool validation passes; tampered routes
        // contain the correct factory here, so the sig mismatch is the final gate.
        const invalidRoutes = [{ from: AERO_ADDRESS, to: USDC_ADDRESS, stable: true, factory: FACTORY_ADDRESS }];

        const sig = await signPayload(nonce, POOL_ADDRESS, 0, 0, deadline, validRoutes, keeper);

        // Execute with tampered routes — route hashes differ from signed payload → sig mismatch
        await expect(
            yieldSenseKeeper.connect(keeper).executeHarvest(
                nonce, POOL_ADDRESS, sig.r, sig.s, sig.v, 0, 0, deadline, invalidRoutes
            )
        ).to.be.revertedWithCustomError(yieldSenseKeeper, "ProcessorNotAttested");
    });

    it("Stale Quote Test: should revert if deadline has passed", async function () {
        const nonce = 3;
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp - 300; // 5 minutes ago
        const routes = [{ from: AERO_ADDRESS, to: USDC_ADDRESS, stable: false, factory: FACTORY_ADDRESS }];

        const sig = await signPayload(nonce, await autocompounder.getAddress(), 0, 0, deadline, routes, keeper);

        await expect(
            yieldSenseKeeper.connect(keeper).executeHarvest(
                nonce, await autocompounder.getAddress(), sig.r, sig.s, sig.v, 0, 0, deadline, routes
            )
        ).to.be.revertedWith("Stale quote");
    });

    it("Flash Loan Simulation: same block deposit/redeem fails", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);

        // Seed the vault with 1 USDC first so share price is initialized (avoids 0-share edge case)
        await yieldSenseKeeper.connect(attacker).deposit(ethers.parseUnits("1", 6), attacker.address);

        const sharesToRedeem = await yieldSenseKeeper.previewDeposit(depositAmount);

        // Stop automining so both txs land in the same block
        await network.provider.send("evm_setAutomine", [false]);

        const depositTx = await yieldSenseKeeper.connect(attacker).deposit(depositAmount, attacker.address);
        const redeemTx  = await yieldSenseKeeper.connect(attacker).redeem(sharesToRedeem, attacker.address, attacker.address);

        // Mine both into one block
        await network.provider.send("evm_mine");
        await network.provider.send("evm_setAutomine", [true]);

        // Inspect receipts directly — chai-matchers cannot intercept already-resolved tx objects
        const depositReceipt = await ethers.provider.getTransactionReceipt(depositTx.hash);
        const redeemReceipt  = await ethers.provider.getTransactionReceipt(redeemTx.hash);

        expect(depositReceipt.status).to.equal(1, "deposit should succeed");
        expect(redeemReceipt.status).to.equal(0, "same-block redeem should revert");
    });

    it("Dust Accounting Test: NAV accurately tracks unused USDC", async function () {
        // Deploy assets to autocompounder
        const amount = ethers.parseUnits("1000", 6);
        await yieldSenseKeeper.connect(user1).deposit(amount, user1.address);
        await yieldSenseKeeper.connect(deployer).deployToPool(amount, 0, 1n);

        // Force some USDC "dust" into the autocompounder
        const dustAmount = ethers.parseUnits("10", 6);
        await asset.connect(user2).transfer(await autocompounder.getAddress(), dustAmount);

        // totalAssets should include the 1000 deployed + 10 dust
        const total = await yieldSenseKeeper.totalAssets();
        // Allow for slight slippage from pool entry
        expect(total).to.be.closeTo(amount + dustAmount, ethers.parseUnits("5", 6));
    });

    it("Unwind Flow Testing: withdrawal from pool liquidity", async function () {
        const amount = ethers.parseUnits("5000", 6);
        await yieldSenseKeeper.connect(user1).deposit(amount, user1.address);

        // Deploy to pool (pass 0 for amountToSwap to use default 50/50 split; 1n minimum LP for test)
        await yieldSenseKeeper.connect(deployer).deployToPool(amount, 0, 1n);

        // User1 tries to withdraw but vault is empty (all deployed)
        const vaultBal = await asset.balanceOf(await yieldSenseKeeper.getAddress());
        expect(vaultBal).to.equal(0);

        // Keeper unwinds LP back to USDC
        const lpBal = await autocompounder.totalStakedLp();
        await yieldSenseKeeper.connect(deployer).withdrawFromPool(lpBal);

        // Vault should have USDC again (allow for slippage)
        const newVaultBal = await asset.balanceOf(await yieldSenseKeeper.getAddress());
        expect(newVaultBal).to.be.greaterThan(ethers.parseUnits("4900", 6));

        // User1 can now redeem (capped to maxRedeem due to slippage on pool exit)
        const shares = await yieldSenseKeeper.maxRedeem(user1.address);
        await yieldSenseKeeper.connect(user1).redeem(shares, user1.address, user1.address);

        const user1FinalBal = await asset.balanceOf(user1.address);
        expect(user1FinalBal).to.be.greaterThan(ethers.parseUnits("4900", 6));
    });

});
