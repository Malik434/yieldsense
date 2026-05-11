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
    const { ownerAddress, workerAddress, signature, timestamp, chainId: reqChainId } = body as {
      ownerAddress: string;
      workerAddress: string;
      signature: string;
      timestamp: number;
      chainId?: number;
    };

    const chainId = reqChainId || 84532;
    const isMainnet = chainId === 8453;

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
      recoveredSigner = ethers.verifyTypedData(
        {
          name: 'YieldSense',
          version: '1',
          chainId,
        }, 
        DEPLOY_TYPES, 
        value, 
        signature
      );
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
    
    const keeperAddress = isMainnet 
      ? (process.env.NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS || process.env.KEEPER_ADDRESS || '0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF')
      : (process.env.NEXT_PUBLIC_TESTNET_KEEPER_ADDRESS || process.env.NEXT_PUBLIC_KEEPER_ADDRESS || '');

    const rpcUrl = isMainnet
      ? (process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://mainnet.base.org')
      : (process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://sepolia.base.org');

    const envInjection = [
      '// YieldSense — per-user env var injection (generated at deploy time)',
      ';(function(e){',
      `  e.USER_ADDRESS=${JSON.stringify(ownerAddress)};`,
      `  e.KEEPER_ADDRESS=${JSON.stringify(keeperAddress)};`,
      `  e.CHAIN_ID=${JSON.stringify(chainId.toString())};`,
      `  e.PROCESSOR_SHARED_SECRET=${JSON.stringify(process.env.PROCESSOR_SHARED_SECRET ?? 'e10383a7f06075735018c89582bd53f966981ab0a386d35763776f0c490fdc58')};`,
      `  e.TELEMETRY_URL=${JSON.stringify(process.env.TELEMETRY_URL ?? 'https://yieldsense.huzaifamalik.tech/api/telemetry')};`,
      `  e.RPC_URL=${JSON.stringify(rpcUrl)};`,
      `  e.DATA_RPC_URL=${JSON.stringify(isMainnet ? 'https://mainnet.base.org' : (process.env.DATA_RPC_URL ?? 'https://mainnet.base.org'))};`,
      `  e.POOL_ADDRESS=${JSON.stringify(isMainnet ? '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d' : (process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS ?? ''))};`,
      `  e.GAUGE_ADDRESS=${JSON.stringify(isMainnet ? '0x4F09bAb2f0E15e2A078A227FE1537665F55b8360' : (process.env.NEXT_PUBLIC_TESTNET_GAUGE_ADDRESS ?? ''))};`,
      `  e.UNISWAP_POOL_ADDRESS=${JSON.stringify(process.env.UNISWAP_POOL_ADDRESS ?? '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59')};`,
      `  e.FORCE_TEST_HARVEST=${JSON.stringify(isMainnet ? 'false' : 'true')};`,
      `  e.FRONTEND_URL=${JSON.stringify(process.env.FRONTEND_URL ?? 'https://yieldsense.huzaifamalik.tech')};`,
      `  e.GRID_CONFIG_JSON=${JSON.stringify(process.env.GRID_CONFIG_JSON ?? 'W3siaWQiOiJnMSIsInJlZmVyZW5jZVByaWNlIjoxLjAsInRyaWdnZXJQZXJjZW50IjowLjAsImFsbG9jYXRpb25CcHMiOjUwMH1d')};`,
      `  e.STOP_LOSS_SECRET_JSON='';`,
      '})(typeof process!=="undefined"?process.env:(globalThis.__ENV__=globalThis.__ENV__||{}));',
    ].join('\n');

    const bootstrap = [
      '',
      ';Promise.resolve(exports.monitorAndExecuteGrid && exports.monitorAndExecuteGrid())',
      '  .catch(function(error){',
      '    console.error(JSON.stringify({ event: "processor_bootstrap_error", message: error && error.message ? error.message : String(error) }));',
      '    if (typeof process !== "undefined") process.exitCode = 1;',
      '  });',
    ].join('\n');

    const bundledCode = `${envInjection}\n${PROCESSOR_BUNDLE}\n${bootstrap}`;

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
