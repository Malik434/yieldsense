import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { PROCESSOR_BUNDLE } from '@/lib/processorBundle';

/**
 * POST /api/deploy
 *
 * Builds a per-user Acurast processor bundle and uploads it to IPFS via Pinata.
 *
 * Architecture note — why no esbuild at request time:
 *   The processor is pre-compiled by webpack (dist/processor.bundle.cjs) and
 *   embedded as a TypeScript constant via scripts/embedProcessor.cjs.  Next.js
 *   statically traces this import and includes the bundle in the serverless
 *   function at build time.  This eliminates all runtime filesystem path
 *   resolution — there is no process.cwd() traversal, no ../src/processor.ts
 *   lookup, and no dependency on the monorepo structure existing at runtime.
 *
 *   Per-user customisation (USER_ADDRESS, KEEPER_ADDRESS) is injected as a
 *   small JavaScript IIFE prepended to the bundle before IPFS upload.  This
 *   is equivalent to esbuild's `define` option but requires no compilation.
 *
 * Authentication:
 *   The request body must include an EIP-712 signature from the ownerAddress
 *   over the deploy parameters.  Requests older than 5 minutes are rejected
 *   to prevent replay attacks.
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
    const { ownerAddress, workerAddress, signature, timestamp } = body as {
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

    // Reject requests older than 5 minutes to prevent replay attacks
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

    // ── Build per-user bundle ───────────────────────────────────────────────
    //
    // The base bundle (PROCESSOR_BUNDLE) is the pre-compiled processor, already
    // containing all dependencies (ethers, acurastHardware, runtimeState,
    // telemetry).  We prepend a tiny IIFE that assigns user-specific values to
    // process.env before any processor code runs.  All other env vars
    // (RPC_URL, DATA_RPC_URL, POOL_ADDRESS, FORCE_TEST_HARVEST, etc.) are
    // injected by the Acurast TEE at job start via includeEnvironmentVariables.
    //
    // The Acurast TEE injects its env vars BEFORE the script executes, so the
    // prepended IIFE always runs after TEE injection — which is intentional.
    // USER_ADDRESS and KEEPER_ADDRESS are set here so they are always correct
    // for this user's bundle regardless of the Acurast job-level env config.

    const keeperAddress =
      process.env.KEEPER_ADDRESS ??
      process.env.NEXT_PUBLIC_KEEPER_ADDRESS ??
      '';

    if (!keeperAddress) {
      console.warn('[deploy] KEEPER_ADDRESS not configured — bundle will have empty keeper address');
    }

    const envInjection = [
      '// YieldSense — per-user env var injection (generated at deploy time)',
      ';(function(e){',
      `  e.USER_ADDRESS=${JSON.stringify(ownerAddress)};`,
      `  e.KEEPER_ADDRESS=${JSON.stringify(keeperAddress)};`,
      `  e.CHAIN_ID=${JSON.stringify(process.env.CHAIN_ID ?? '84532')};`,
      `  e.STOP_LOSS_SECRET_JSON='';`,
      '})(typeof process!=="undefined"?process.env:(globalThis.__ENV__=globalThis.__ENV__||{}));',
    ].join('\n');

    const bundledCode = `${envInjection}\n${PROCESSOR_BUNDLE}`;

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
