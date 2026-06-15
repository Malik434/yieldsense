const { ethers } = require("ethers");

const POOL_ADDRESS    = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const GAUGE_ADDRESS   = "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360";
const USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_ADDRESS    = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ROUTER_ADDRESS  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const DEPLOYER_ADDRESS = "0x1Aa137C177a58D98d24d143b3533043b419479DD";
const KEEPER_ADDR      = "0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF";
const AUTOCOMPOUNDER_ADDR = "0x8654862B4FaB12aC09843cc1b644E6dA5aa6DC4A";
const EXECUTOR_REGISTRY_ADDR = "0x0000000000000000000000000000000000000000";

const abiAutocompounder = [
  "constructor(address,address,address,address,address,address,address)"
];

const abiKeeper = [
  "constructor(address,address,address,address,address)"
];

const ifaceAuto = new ethers.Interface(abiAutocompounder);
const argsAuto = ifaceAuto.encodeDeploy([
  POOL_ADDRESS,
  GAUGE_ADDRESS,
  USDC_ADDRESS,
  AERO_ADDRESS,
  ROUTER_ADDRESS,
  FACTORY_ADDRESS,
  DEPLOYER_ADDRESS
]);

const ifaceKeeper = new ethers.Interface(abiKeeper);
const argsKeeper = ifaceKeeper.encodeDeploy([
  USDC_ADDRESS,
  AERO_ADDRESS,
  DEPLOYER_ADDRESS,
  AUTOCOMPOUNDER_ADDR,
  EXECUTOR_REGISTRY_ADDR
]);

console.log("Autocompounder Args:");
console.log(argsAuto.slice(2));
console.log("\nKeeper Args:");
console.log(argsKeeper.slice(2));
