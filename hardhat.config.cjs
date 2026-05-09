require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 8453,
      forking: {
        url: process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
        blockNumber: 45783135
      }
    },
    baseSepolia: {
      url: process.env.RPC_URL || "https://sepolia.base.org",
      accounts: process.env.ACURAST_WORKER_KEY ? [process.env.ACURAST_WORKER_KEY] : [],
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
