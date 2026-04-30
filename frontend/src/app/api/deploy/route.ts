import { NextResponse } from 'next/server';
import * as esbuild from 'esbuild';
import path from 'path';
import { ethers } from 'ethers';

/**
 * POST /api/deploy
 *
 * Bundles src/processor.ts with esbuild, injects user-specific env vars,
 * and uploads the result to IPFS via Pinata.
 *
 * Authentication:
 *   The request body must include an EIP-712 signature from the `ownerAddress`
 *   over the deploy parameters. This ensures only the actual wallet owner can
 *   trigger a bundle that bakes their address into the processor runtime, and
 *   prevents unauthenticated callers from exhausting the Pinata quota.
 *
 * EIP-712 domain & types are minimal and intentionally do not include
 * verifyingContract so this auth check is independent of the keeper address.
 */

const DEPLOY_DOMAIN = {
  name: 'YieldSense',
  version: '1',
  chainId: parseInt(process.env.CHAIN_ID ?? '84532'),
} as const;

const DEPLOY_TYPES: Record<string, { name: string; type: string }[]> = {
  DeployRequest: [
    { name: 'ownerAddress', type: 'address' },
    { name: 'workerAddress', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { strategyParams, ownerAddress, workerAddress, signature, timestamp } = body as {
      strategyParams: Record<string, unknown>;
      ownerAddress: string;
      workerAddress: string;
      signature: string;
      timestamp: number;
    };

    // ── Authentication ──────────────────────────────────────────────────────
    if (!ownerAddress || !workerAddress || !signature || !timestamp) {
      return NextResponse.json(
        { error: 'Missing required fields: ownerAddress, workerAddress, signature, timestamp' },
        { status: 400 }
      );
    }

    // Reject requests older than 5 minutes to prevent replay
    const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(timestamp / 1000);
    if (Math.abs(ageSeconds) > 300) {
      return NextResponse.json(
        { error: 'Deploy request expired (timestamp older than 5 minutes)' },
        { status: 400 }
      );
    }

    const value = {
      ownerAddress,
      workerAddress,
      timestamp: BigInt(timestamp),
    };

    let recoveredSigner: string;
    try {
      recoveredSigner = ethers.verifyTypedData(DEPLOY_DOMAIN, DEPLOY_TYPES, value, signature);
    } catch {
      return NextResponse.json({ error: 'Signature verification failed' }, { status: 422 });
    }

    if (recoveredSigner.toLowerCase() !== ownerAddress.toLowerCase()) {
      return NextResponse.json(
        { error: 'Signature mismatch — signer does not match ownerAddress' },
        { status: 403 }
      );
    }

    // ── Bundle ──────────────────────────────────────────────────────────────
    // processor.ts lives in yieldsense/src/, one level above frontend/
    const rootDir = path.resolve(process.cwd(), '../');
    const processorPath = path.join(rootDir, 'src', 'processor.ts');

    const result = await esbuild.build({
      entryPoints: [processorPath],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      define: {
        'process.env.USER_ADDRESS': JSON.stringify(ownerAddress),
        'process.env.KEEPER_ADDRESS': JSON.stringify(process.env.NEXT_PUBLIC_KEEPER_ADDRESS ?? ''),
        'process.env.RPC_URL': JSON.stringify(process.env.NEXT_PUBLIC_RPC_URL ?? ''),
        'process.env.CHAIN_ID': JSON.stringify(process.env.CHAIN_ID ?? '84532'),
        // Strategy params are NOT baked into the bundle to keep them confidential.
        // The processor fetches them at runtime from /api/strategy using the EIP-712
        // signed payload stored there, and verifies the signature before using them.
        'process.env.STOP_LOSS_SECRET_JSON': JSON.stringify(''),
      },
    });

    const bundledCode = result.outputFiles[0].text;

    // ── IPFS upload ─────────────────────────────────────────────────────────
    const pinataJwt = process.env.PINATA_JWT;
    if (!pinataJwt) {
      console.warn('[deploy] PINATA_JWT not set — returning mock CID for local dev');
      return NextResponse.json({
        ipfsCid: `QmMock_${ownerAddress.slice(2, 10)}_${Date.now()}`,
        deploymentId: `deploy_local_${Date.now()}`,
      });
    }

    const blob = new Blob([bundledCode], { type: 'application/javascript' });
    const formData = new FormData();
    formData.append('file', blob, 'processor.js');
    formData.append(
      'pinataMetadata',
      JSON.stringify({ name: `ys-processor-${ownerAddress.slice(0, 10)}` })
    );

    const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pinataJwt}` },
      body: formData,
    });

    if (!pinataRes.ok) {
      const errorText = await pinataRes.text();
      throw new Error(`Pinata upload failed: ${pinataRes.status} ${errorText}`);
    }

    const pinataJson = await pinataRes.json();
    return NextResponse.json({
      ipfsCid: pinataJson.IpfsHash,
      deploymentId: `deploy_${pinataJson.IpfsHash.slice(-8)}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[deploy] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
