import { ethers } from "ethers";

export interface HarvestSignaturePayload {
  payloadHash: string;
  r: string;
  s: string;
  v: number;
}

export interface Route {
  from: string;
  to: string;
  stable: boolean;
  factory: string;
}

export interface HarvestParams {
  nonce: string;
  targetPool: string;
  minLpOut: string;
  amountToSwap: string;
  deadline: number;
  routes: Route[];
}

/**
 * Telemetry/debug hash for the deployed executeHarvest calldata shape.
 * The contract authorizes harvests by `msg.sender` attestation, not by this hash.
 */
export function buildHarvestPayloadHash(params: HarvestParams): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "uint256", "uint256", "tuple(address from, address to, bool stable, address factory)[]"],
    [
      params.nonce,
      ethers.getAddress(params.targetPool),
      params.minLpOut,
      params.amountToSwap,
      params.deadline,
      params.routes.map((route) => ({
        from: ethers.getAddress(route.from),
        to: ethers.getAddress(route.to),
        stable: route.stable,
        factory: ethers.getAddress(route.factory),
      })),
    ]
  ));
}

export function getDomain(chainId: number, keeperAddress: string) {
  return {
    name: "YieldSense",
    version: "1",
    chainId: chainId,
    verifyingContract: ethers.getAddress(keeperAddress),
  };
}

export const EIP712_TYPES = {
  HarvestPayload: [
    { name: "keeper", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "targetPool", type: "address" },
    { name: "minLpOut", type: "uint256" },
    { name: "amountToSwap", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "routes", type: "Route[]" },
  ],
  Route: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "stable", type: "bool" },
    { name: "factory", type: "address" },
  ],
};

export async function signHarvestPayloadEIP712(
  privateKey: string,
  chainId: number,
  keeperAddress: string,
  params: HarvestParams
): Promise<HarvestSignaturePayload> {
  const wallet = new ethers.Wallet(privateKey);
  const domain = getDomain(chainId, keeperAddress);
  
  const value = {
    keeper: ethers.getAddress(wallet.address),
    nonce: params.nonce,
    targetPool: ethers.getAddress(params.targetPool),
    minLpOut: params.minLpOut,
    amountToSwap: params.amountToSwap,
    deadline: params.deadline,
    routes: params.routes.map(r => ({
      from: ethers.getAddress(r.from),
      to: ethers.getAddress(r.to),
      stable: r.stable,
      factory: ethers.getAddress(r.factory)
    }))
  };

  const payloadHash = ethers.TypedDataEncoder.hash(domain, EIP712_TYPES, value);
  const signatureHex = await wallet.signTypedData(domain, EIP712_TYPES, value);
  const signature = ethers.Signature.from(signatureHex);

  return {
    payloadHash,
    r: signature.r,
    s: signature.s,
    v: signature.v,
  };
}

export function verifyPayloadSignerEIP712(
  expectedSigner: string,
  chainId: number,
  keeperAddress: string,
  params: HarvestParams,
  r: string,
  s: string,
  v: number
): boolean {
  const domain = getDomain(chainId, keeperAddress);
  const value = {
    keeper: ethers.getAddress(expectedSigner),
    nonce: params.nonce,
    targetPool: ethers.getAddress(params.targetPool),
    minLpOut: params.minLpOut,
    amountToSwap: params.amountToSwap,
    deadline: params.deadline,
    routes: params.routes.map(r => ({
      from: ethers.getAddress(r.from),
      to: ethers.getAddress(r.to),
      stable: r.stable,
      factory: ethers.getAddress(r.factory)
    }))
  };
  const recovered = ethers.verifyTypedData(domain, EIP712_TYPES, value, { r, s, v });
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}
