// SPDX-License-Identifier: MIT
"use strict";

/**
 * YieldSenseKeeper — Comprehensive Test Suite
 *
 * Covers:
 *   1. P-256 attestation root management
 *   2. registerProcessor  — cryptographic P-256 TEE attestation path
 *   3. ownerAttestProcessor / revokeProcessor — privileged management path
 *   4. executeHarvest     — secp256k1 signature + TEE attestation gate
 *   5. executeTrade       — secp256k1 signature + TEE attestation gate + nonce bitmap
 *   6. verifyAcurastSignature — view helper
 *   7. Timelock setters (initiateUpdate / applyUpdate)
 *   8. deposit / withdraw with performance fee
 *
 * P-256 signing uses @noble/curves (available as a transitive dep of ethers v6).
 * Ethereum ECDSA signing uses ethers.Wallet.signMessage (EIP-191).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { p256 } = require("@noble/curves/p256");

// ─── P-256 test helpers ────────────────────────────────────────────────────

/**
 * Generate a fresh P-256 (secp256r1) key pair for the attestation root CA.
 * Returns the private key as Uint8Array and the public key coordinates as
 * 0x-prefixed 32-byte hex strings ready for the contract.
 */
function generateP256KeyPair() {
  const privKey = p256.utils.randomPrivateKey();
  // Uncompressed public key: 0x04 || Qx (32 B) || Qy (32 B)
  const pubKey = p256.getPublicKey(privKey, false);
  const qx = "0x" + Buffer.from(pubKey.slice(1, 33)).toString("hex");
  const qy = "0x" + Buffer.from(pubKey.slice(33, 65)).toString("hex");
  return { privKey, qx, qy };
}

/**
 * Sign a 32-byte hash with a P-256 private key using raw ECDSA (no additional
 * hashing — the hash is used directly as the ECDSA message scalar `e`).
 *
 * This matches what OpenZeppelin P256.verify() and the RIP-7212 precompile
 * expect: the `h` argument IS the pre-computed hash.
 */
function signP256(privKey, hashHex) {
  const hash = Buffer.from(hashHex.replace("0x", ""), "hex");
  const sig = p256.sign(hash, privKey, { lowS: true });
  const r = "0x" + sig.r.toString(16).padStart(64, "0");
  const s = "0x" + sig.s.toString(16).padStart(64, "0");
  return { r, s };
}

// ─── secp256k1 helper (harvest / trade signing) ────────────────────────────

/**
 * Build and sign a harvest payload the same way the off-chain worker does.
 * Returns { payloadHash, r, s, v } ready for executeHarvest().
 */
async function buildHarvestPayload(wallet, keeperAddress, poolAddress, aprBps, rewardCents, timestamp) {
  const payloadHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint256", "uint256"],
      [keeperAddress, poolAddress, aprBps, rewardCents, timestamp]
    )
  );
  // EIP-191: wallet.signMessage hashes again with "\x19Ethereum Signed Message:\n32"
  const rawSig = await wallet.signMessage(ethers.getBytes(payloadHash));
  const { r, s, v } = ethers.Signature.from(rawSig);
  return { payloadHash, r, s, v };
}

/**
 * Build and sign a trade digest the same way the off-chain worker does.
 * Returns { digest, signature (65 bytes hex) } ready for executeTrade().
 */
async function buildTradePayload(wallet, chainId, keeperAddress, userAddress, pnlDelta, nonce) {
  const digest = ethers.keccak256(
    ethers.solidityPacked(
      ["uint256", "address", "address", "int256", "uint256"],
      [chainId, keeperAddress, userAddress, pnlDelta, nonce]
    )
  );
  const rawSig = await wallet.signMessage(ethers.getBytes(digest));
  return { digest, signature: rawSig };
}

// ─── Constants ────────────────────────────────────────────────────────────

const ZERO_ADDR = ethers.ZeroAddress;
const POOL_ADDR  = "0x1111111111111111111111111111111111111111"; // arbitrary placeholder
const MINT_AMOUNT = ethers.parseUnits("100000", 18);

// ─── Test suite ────────────────────────────────────────────────────────────

describe("YieldSenseKeeper — P-256 Attestation & TEE Validation", function () {
  // Increase timeout: P-256 fallback Solidity math is ~4M gas on a local node
  this.timeout(120_000);

  let keeper;
  let mockToken;
  let owner;          // deployer / contract owner
  let alice;          // regular user (depositor)
  let bob;            // unattested signer (attack vector)
  let signerWallet;   // secp256k1 wallet = acurastSigner in the contract
  let attestRoot;     // P-256 root CA key pair

  // Deploy fresh contracts before each test to ensure isolation
  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // Fresh Ethereum wallet — will be set as acurastSigner and then attested
    signerWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    // Fresh P-256 attestation root CA key pair
    attestRoot = generateP256KeyPair();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock USDC", "mUSDC");
    await mockToken.waitForDeployment();

    // Deploy YieldSenseKeeper
    const KeeperFactory = await ethers.getContractFactory("YieldSenseKeeper");
    keeper = await KeeperFactory.deploy(
      await mockToken.getAddress(),
      signerWallet.address,    // acurastSigner
      owner.address,           // yieldSource  (owner has tokens + approves)
      alice.address            // counterparty (receives loss transfers)
    );
    await keeper.waitForDeployment();

    // Give the owner (yieldSource) tokens and approve the keeper for trade tests
    await mockToken.mint(owner.address, MINT_AMOUNT);
    await mockToken.connect(owner).approve(await keeper.getAddress(), ethers.MaxUint256);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Attestation Root Management (setAttestationRoot)
  // ══════════════════════════════════════════════════════════════════════════

  describe("setAttestationRoot", function () {
    it("owner can set the P-256 root public key", async function () {
      await keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy);
      expect(await keeper.attestationRootQx()).to.equal(attestRoot.qx);
      expect(await keeper.attestationRootQy()).to.equal(attestRoot.qy);
    });

    it("emits AttestationRootUpdated with correct coordinates", async function () {
      await expect(keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy))
        .to.emit(keeper, "AttestationRootUpdated")
        .withArgs(attestRoot.qx, attestRoot.qy);
    });

    it("non-owner cannot set attestation root", async function () {
      await expect(
        keeper.connect(alice).setAttestationRoot(attestRoot.qx, attestRoot.qy)
      ).to.be.reverted; // OwnableUnauthorizedAccount
    });

    it("root can be rotated to a new key pair", async function () {
      const newRoot = generateP256KeyPair();
      await keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy);
      await keeper.setAttestationRoot(newRoot.qx, newRoot.qy);
      expect(await keeper.attestationRootQx()).to.equal(newRoot.qx);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. registerProcessor — Cryptographic P-256 Path
  // ══════════════════════════════════════════════════════════════════════════

  describe("registerProcessor (P-256 cryptographic attestation)", function () {
    let certHash;

    beforeEach(async function () {
      // Set the root key before each sub-test
      await keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy);

      // certHash represents the keccak256 of the TEE attestation certificate
      // binding signerWallet.address to this processor hardware
      certHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "string"],
          [signerWallet.address, "acurast-cert-v1"]
        )
      );
    });

    it("registers a processor when given a valid P-256 signature", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      await keeper.registerProcessor(signerWallet.address, certHash, r, s);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;
    });

    it("emits ProcessorAttested on successful registration", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      await expect(keeper.registerProcessor(signerWallet.address, certHash, r, s))
        .to.emit(keeper, "ProcessorAttested")
        .withArgs(signerWallet.address, certHash);
    });

    it("anyone can call registerProcessor (permissionless, gated by P-256)", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      // alice (not owner) can submit a valid attestation
      await keeper.connect(alice).registerProcessor(signerWallet.address, certHash, r, s);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;
    });

    it("reverts with InvalidAttestationSignature if attestation root is not set", async function () {
      // Deploy a keeper with no root set
      const KeeperFactory = await ethers.getContractFactory("YieldSenseKeeper");
      const fresh = await KeeperFactory.deploy(
        await mockToken.getAddress(),
        signerWallet.address,
        owner.address,
        alice.address
      );
      const { r, s } = signP256(attestRoot.privKey, certHash);
      await expect(
        fresh.registerProcessor(signerWallet.address, certHash, r, s)
      ).to.be.revertedWithCustomError(fresh, "InvalidAttestationSignature");
    });

    it("reverts with InvalidAttestationSignature for a tampered r component", async function () {
      const { s } = signP256(attestRoot.privKey, certHash);
      const badR = "0x" + "ff".repeat(32);
      await expect(
        keeper.registerProcessor(signerWallet.address, certHash, badR, s)
      ).to.be.revertedWithCustomError(keeper, "InvalidAttestationSignature");
    });

    it("reverts with InvalidAttestationSignature for a tampered s component", async function () {
      const { r } = signP256(attestRoot.privKey, certHash);
      const badS = "0x" + "ff".repeat(32);
      await expect(
        keeper.registerProcessor(signerWallet.address, certHash, r, badS)
      ).to.be.revertedWithCustomError(keeper, "InvalidAttestationSignature");
    });

    it("reverts with InvalidAttestationSignature when signed with a different (wrong) P-256 key", async function () {
      const rogue = generateP256KeyPair();
      const { r, s } = signP256(rogue.privKey, certHash); // signed by rogue, not root CA
      await expect(
        keeper.registerProcessor(signerWallet.address, certHash, r, s)
      ).to.be.revertedWithCustomError(keeper, "InvalidAttestationSignature");
    });

    it("reverts with InvalidAttestationSignature when certHash has been tampered", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      const tamperedHash = ethers.keccak256(ethers.toUtf8Bytes("different-cert-data"));
      await expect(
        keeper.registerProcessor(signerWallet.address, tamperedHash, r, s)
      ).to.be.revertedWithCustomError(keeper, "InvalidAttestationSignature");
    });

    it("reverts with InvalidAddress for zero processor address", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      await expect(
        keeper.registerProcessor(ZERO_ADDR, certHash, r, s)
      ).to.be.revertedWithCustomError(keeper, "InvalidAddress");
    });

    it("re-registration with the same data is idempotent", async function () {
      const { r, s } = signP256(attestRoot.privKey, certHash);
      await keeper.registerProcessor(signerWallet.address, certHash, r, s);
      // Registering again should not revert — idempotent
      await keeper.registerProcessor(signerWallet.address, certHash, r, s);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ownerAttestProcessor / revokeProcessor
  // ══════════════════════════════════════════════════════════════════════════

  describe("ownerAttestProcessor / revokeProcessor", function () {
    it("owner can attest a processor directly (testnet shortcut)", async function () {
      await keeper.ownerAttestProcessor(signerWallet.address);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;
    });

    it("ownerAttestProcessor emits ProcessorAttested with certHash = bytes32(0)", async function () {
      await expect(keeper.ownerAttestProcessor(signerWallet.address))
        .to.emit(keeper, "ProcessorAttested")
        .withArgs(signerWallet.address, ethers.ZeroHash);
    });

    it("non-owner cannot call ownerAttestProcessor", async function () {
      await expect(
        keeper.connect(alice).ownerAttestProcessor(signerWallet.address)
      ).to.be.reverted;
    });

    it("ownerAttestProcessor reverts for zero address", async function () {
      await expect(keeper.ownerAttestProcessor(ZERO_ADDR))
        .to.be.revertedWithCustomError(keeper, "InvalidAddress");
    });

    it("owner can revoke an attested processor", async function () {
      await keeper.ownerAttestProcessor(signerWallet.address);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;

      await keeper.revokeProcessor(signerWallet.address);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.false;
    });

    it("non-owner cannot revoke", async function () {
      await keeper.ownerAttestProcessor(signerWallet.address);
      await expect(
        keeper.connect(alice).revokeProcessor(signerWallet.address)
      ).to.be.reverted;
    });

    it("after revocation, P-256 re-registration restores attestation", async function () {
      await keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy);
      const certHash = ethers.keccak256(ethers.toUtf8Bytes("cert-v2"));
      const { r, s } = signP256(attestRoot.privKey, certHash);

      await keeper.ownerAttestProcessor(signerWallet.address);
      await keeper.revokeProcessor(signerWallet.address);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.false;

      await keeper.registerProcessor(signerWallet.address, certHash, r, s);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. executeHarvest — TEE Attestation Gate
  // ══════════════════════════════════════════════════════════════════════════

  describe("executeHarvest — TEE attestation gate", function () {
    let keeperAddr;
    let timestamp;

    beforeEach(async function () {
      keeperAddr = await keeper.getAddress();
      timestamp = Math.floor(Date.now() / 1000);
      // Attest the signerWallet so it can sign harvests
      await keeper.ownerAttestProcessor(signerWallet.address);
    });

    it("attested signer can successfully execute a harvest", async function () {
      const { payloadHash, r, s, v } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 500, 0, timestamp
      );
      await expect(keeper.executeHarvest(payloadHash, r, s, v))
        .to.emit(keeper, "HarvestExecuted")
        .withArgs(payloadHash);
    });

    it("updates lastHarvest timestamp after successful harvest", async function () {
      const before = await keeper.lastHarvest();
      const { payloadHash, r, s, v } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 500, 0, timestamp
      );
      await keeper.executeHarvest(payloadHash, r, s, v);
      const after = await keeper.lastHarvest();
      expect(after > before).to.be.true;
    });

    it("unattested signer reverts with ProcessorNotAttested", async function () {
      // bob is not attested — create a wallet for him
      const bobWallet = ethers.Wallet.createRandom().connect(ethers.provider);
      // Update acurastSigner to bobWallet so verifyAcurastSignature passes,
      // but attestedProcessors[bob] = false → second check fails
      // We cannot easily change acurastSigner (timelocked), so we use a fresh keeper
      const KeeperFactory = await ethers.getContractFactory("YieldSenseKeeper");
      const fresh = await KeeperFactory.deploy(
        await mockToken.getAddress(),
        bobWallet.address,   // bobWallet IS the acurastSigner
        owner.address,
        alice.address
      );
      // Bob is the acurastSigner but NOT attested — harvest must fail
      const freshAddr = await fresh.getAddress();
      const { payloadHash, r, s, v } = await buildHarvestPayload(
        bobWallet, freshAddr, POOL_ADDR, 500, 0, timestamp
      );
      await expect(fresh.executeHarvest(payloadHash, r, s, v))
        .to.be.revertedWithCustomError(fresh, "ProcessorNotAttested");
    });

    it("invalid signature reverts with InvalidSignature", async function () {
      // Sign with signerWallet but submit garbage r/s
      const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const garbage  = ethers.keccak256(ethers.toUtf8Bytes("garbage"));
      const badV = 27;
      await expect(keeper.executeHarvest(fakeHash, garbage, garbage, badV))
        .to.be.revertedWithCustomError(keeper, "InvalidSignature");
    });

    it("revoked signer reverts with ProcessorNotAttested after revocation", async function () {
      // Attest → harvest works → revoke → harvest fails
      const { payloadHash: ph1, r: r1, s: s1, v: v1 } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 500, 0, timestamp
      );
      await keeper.executeHarvest(ph1, r1, s1, v1); // succeeds

      await keeper.revokeProcessor(signerWallet.address);

      const { payloadHash: ph2, r: r2, s: s2, v: v2 } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 600, 0, timestamp + 1
      );
      await expect(keeper.executeHarvest(ph2, r2, s2, v2))
        .to.be.revertedWithCustomError(keeper, "ProcessorNotAttested");
    });

    it("different signer (wrong key) reverts with InvalidSignature", async function () {
      const impostor = ethers.Wallet.createRandom().connect(ethers.provider);
      // acurastSigner is signerWallet, impostor signs → verifyAcurastSignature fails
      const { payloadHash, r, s, v } = await buildHarvestPayload(
        impostor, keeperAddr, POOL_ADDR, 500, 0, timestamp
      );
      await expect(keeper.executeHarvest(payloadHash, r, s, v))
        .to.be.revertedWithCustomError(keeper, "InvalidSignature");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. executeTrade — TEE Attestation Gate + Nonce Bitmap
  // ══════════════════════════════════════════════════════════════════════════

  describe("executeTrade — TEE attestation gate & nonce bitmap", function () {
    let keeperAddr;
    let chainId;

    beforeEach(async function () {
      keeperAddr = await keeper.getAddress();
      const network = await ethers.provider.getNetwork();
      chainId = Number(network.chainId);

      // Attest the signer
      await keeper.ownerAttestProcessor(signerWallet.address);
    });

    it("attested signer can execute trade with pnlDelta = 0 (no token transfer)", async function () {
      const { digest, signature } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, 0n, 0n
      );
      await expect(keeper.executeTrade(alice.address, 0, 0, signature))
        .to.emit(keeper, "TradeExecuted")
        .withArgs(alice.address, 0n, 0n, digest);
    });

    it("positive pnlDelta credits user balance and pulls from yieldSource", async function () {
      const profit = ethers.parseUnits("10", 18);
      const { signature } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, profit, 0n
      );
      await keeper.executeTrade(alice.address, profit, 0, signature);
      const data = await keeper.userData(alice.address);
      expect(data.balance).to.equal(profit);
    });

    it("unattested signer reverts with ProcessorNotAttested on trade", async function () {
      const KeeperFactory = await ethers.getContractFactory("YieldSenseKeeper");
      const bobWallet = ethers.Wallet.createRandom().connect(ethers.provider);
      const fresh = await KeeperFactory.deploy(
        await mockToken.getAddress(),
        bobWallet.address,
        owner.address,
        alice.address
      );
      const freshAddr = await fresh.getAddress();
      const { signature } = await buildTradePayload(
        bobWallet, chainId, freshAddr, alice.address, 0n, 0n
      );
      await expect(fresh.executeTrade(alice.address, 0, 0, signature))
        .to.be.revertedWithCustomError(fresh, "ProcessorNotAttested");
    });

    it("nonce replay reverts with NonceAlreadyUsed", async function () {
      const { signature } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, 0n, 42n
      );
      await keeper.executeTrade(alice.address, 0, 42, signature);

      // Build a new signature for nonce 42 again (digest changes but nonce slot same)
      const { signature: sig2 } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, 0n, 42n
      );
      await expect(keeper.executeTrade(alice.address, 0, 42, sig2))
        .to.be.revertedWithCustomError(keeper, "NonceAlreadyUsed");
    });

    it("different nonce slots work independently (bitmap isolation)", async function () {
      // nonces 0 and 256 are in different bitmap words
      const { signature: sig0 } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, 0n, 0n
      );
      const { signature: sig256 } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, 0n, 256n
      );
      await keeper.executeTrade(alice.address, 0, 0, sig0);
      // nonce 256 (word 1, bit 0) must succeed — different slot
      await keeper.executeTrade(alice.address, 0, 256, sig256);
    });

    it("zero user address reverts with InvalidAddress", async function () {
      const { signature } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, ZERO_ADDR, 0n, 0n
      );
      await expect(keeper.executeTrade(ZERO_ADDR, 0, 0, signature))
        .to.be.revertedWithCustomError(keeper, "InvalidAddress");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. verifyAcurastSignature (view helper)
  // ══════════════════════════════════════════════════════════════════════════

  describe("verifyAcurastSignature", function () {
    it("returns true when the correct signer signs the digest", async function () {
      const digest = ethers.keccak256(ethers.toUtf8Bytes("test-payload"));
      const rawSig = await signerWallet.signMessage(ethers.getBytes(digest));
      expect(await keeper.verifyAcurastSignature(digest, rawSig)).to.be.true;
    });

    it("returns false when a different wallet signs the digest", async function () {
      const digest = ethers.keccak256(ethers.toUtf8Bytes("test-payload"));
      const impostor = ethers.Wallet.createRandom();
      const rawSig = await impostor.signMessage(ethers.getBytes(digest));
      expect(await keeper.verifyAcurastSignature(digest, rawSig)).to.be.false;
    });

    it("returns false when digest is modified after signing", async function () {
      const digest = ethers.keccak256(ethers.toUtf8Bytes("correct-payload"));
      const rawSig = await signerWallet.signMessage(ethers.getBytes(digest));
      const wrongDigest = ethers.keccak256(ethers.toUtf8Bytes("wrong-payload"));
      expect(await keeper.verifyAcurastSignature(wrongDigest, rawSig)).to.be.false;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. Timelock setters (initiateUpdate / applyUpdate)
  // ══════════════════════════════════════════════════════════════════════════

  describe("Timelock setters", function () {
    it("owner can initiate an update and it emits UpdateInitiated", async function () {
      const key = ethers.encodeBytes32String("yieldSource");
      await expect(keeper.initiateUpdate(key, alice.address))
        .to.emit(keeper, "UpdateInitiated");
    });

    it("applyUpdate reverts if timelock has not elapsed", async function () {
      const key = ethers.encodeBytes32String("yieldSource");
      await keeper.initiateUpdate(key, alice.address);
      await expect(keeper.applyUpdate(key))
        .to.be.revertedWithCustomError(keeper, "TimelockNotExpired");
    });

    it("applyUpdate succeeds after TIMELOCK_DELAY (2 days)", async function () {
      const key = ethers.encodeBytes32String("yieldSource");
      await keeper.initiateUpdate(key, alice.address);

      // Fast-forward 2 days + 1 second
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(keeper.applyUpdate(key)).to.emit(keeper, "UpdateApplied");
      expect(await keeper.yieldSource()).to.equal(alice.address);
    });

    it("applyUpdate reverts with NoUpdatePending when nothing was initiated", async function () {
      const key = ethers.encodeBytes32String("yieldSource");
      await expect(keeper.applyUpdate(key))
        .to.be.revertedWithCustomError(keeper, "NoUpdatePending");
    });

    it("non-owner cannot initiate update", async function () {
      const key = ethers.encodeBytes32String("yieldSource");
      await expect(keeper.connect(alice).initiateUpdate(key, bob.address)).to.be.reverted;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. deposit / withdraw with 10% performance fee
  // ══════════════════════════════════════════════════════════════════════════

  describe("deposit / withdraw with performance fee", function () {
    const DEPOSIT = ethers.parseUnits("1000", 18);

    beforeEach(async function () {
      // Mint tokens for alice and approve the keeper
      await mockToken.mint(alice.address, DEPOSIT);
      await mockToken.connect(alice).approve(await keeper.getAddress(), DEPOSIT);
    });

    it("deposit increases user balance and emits Deposited", async function () {
      await expect(keeper.connect(alice).deposit(DEPOSIT))
        .to.emit(keeper, "Deposited")
        .withArgs(alice.address, DEPOSIT, DEPOSIT);

      const data = await keeper.userData(alice.address);
      expect(data.balance).to.equal(DEPOSIT);
      expect(data.initialDeposit).to.equal(DEPOSIT);
    });

    it("deposit with zero amount reverts with InvalidAmount", async function () {
      await expect(keeper.connect(alice).deposit(0))
        .to.be.revertedWithCustomError(keeper, "InvalidAmount");
    });

    it("withdraw with no profit returns full deposit (no fee)", async function () {
      await keeper.connect(alice).deposit(DEPOSIT);

      const aliceBefore = await mockToken.balanceOf(alice.address);
      await keeper.connect(alice).withdraw();
      const aliceAfter = await mockToken.balanceOf(alice.address);

      expect(aliceAfter - aliceBefore).to.equal(DEPOSIT);
    });

    it("10% performance fee is applied on profit and sent to feeRecipient", async function () {
      await keeper.connect(alice).deposit(DEPOSIT);

      // Simulate profit via executeTrade (positive pnlDelta)
      const keeperAddr = await keeper.getAddress();
      const network = await ethers.provider.getNetwork();
      const chainId = Number(network.chainId);
      await keeper.ownerAttestProcessor(signerWallet.address);

      const profit = ethers.parseUnits("100", 18); // 10% profit
      const { signature } = await buildTradePayload(
        signerWallet, chainId, keeperAddr, alice.address, profit, 0n
      );
      await keeper.executeTrade(alice.address, profit, 0, signature);

      // Alice's balance should now be DEPOSIT + profit = 1100 tokens
      const data = await keeper.userData(alice.address);
      expect(data.balance).to.equal(DEPOSIT + profit);

      const feeRecipient = await keeper.feeRecipient();
      const recipientBefore = await mockToken.balanceOf(feeRecipient);
      const aliceBefore = await mockToken.balanceOf(alice.address);

      await keeper.connect(alice).withdraw();

      const recipientAfter = await mockToken.balanceOf(feeRecipient);
      const aliceAfter = await mockToken.balanceOf(alice.address);

      // Performance fee = 10% of 100 tokens = 10 tokens
      const expectedFee = profit * 1000n / 10000n; // PERFORMANCE_FEE_BPS / BPS_DENOMINATOR
      expect(recipientAfter - recipientBefore).to.equal(expectedFee);
      // Alice receives DEPOSIT + profit - fee = 1090 tokens
      expect(aliceAfter - aliceBefore).to.equal(DEPOSIT + profit - expectedFee);
    });

    it("withdraw with zero balance reverts with InsufficientBalance", async function () {
      await expect(keeper.connect(alice).withdraw())
        .to.be.revertedWithCustomError(keeper, "InsufficientBalance");
    });

    it("withdraw clears user data (CEI pattern — no double withdrawal)", async function () {
      await keeper.connect(alice).deposit(DEPOSIT);
      await keeper.connect(alice).withdraw();

      // Second withdraw must revert — balance cleared
      await expect(keeper.connect(alice).withdraw())
        .to.be.revertedWithCustomError(keeper, "InsufficientBalance");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. End-to-end: full P-256 registration → harvest → revoke flow
  // ══════════════════════════════════════════════════════════════════════════

  describe("End-to-end: P-256 registration → harvest → revocation", function () {
    it("full lifecycle works correctly", async function () {
      const keeperAddr = await keeper.getAddress();
      const timestamp  = Math.floor(Date.now() / 1000);

      // Step 1: Set P-256 root
      await keeper.setAttestationRoot(attestRoot.qx, attestRoot.qy);

      // Step 2: Register processor via P-256 attestation certificate
      const certHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256"],
          [signerWallet.address, timestamp]
        )
      );
      const { r: pr, s: ps } = signP256(attestRoot.privKey, certHash);
      await keeper.registerProcessor(signerWallet.address, certHash, pr, ps);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.true;

      // Step 3: Execute harvest as newly attested processor
      const { payloadHash, r, s, v } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 300, 0, timestamp
      );
      await expect(keeper.executeHarvest(payloadHash, r, s, v))
        .to.emit(keeper, "HarvestExecuted");

      // Step 4: Revoke processor
      await keeper.revokeProcessor(signerWallet.address);
      expect(await keeper.attestedProcessors(signerWallet.address)).to.be.false;

      // Step 5: Harvest must fail after revocation
      const { payloadHash: ph2, r: r2, s: s2, v: v2 } = await buildHarvestPayload(
        signerWallet, keeperAddr, POOL_ADDR, 300, 0, timestamp + 1
      );
      await expect(keeper.executeHarvest(ph2, r2, s2, v2))
        .to.be.revertedWithCustomError(keeper, "ProcessorNotAttested");
    });
  });
});
