/**
 * /api/strategy — Relay endpoint for user confidential strategy parameters.
 *
 * POST: Accepts EIP-712 signed strategy params from the frontend.
 *       Stores them keyed by signer address for the Acurast processor to fetch.
 *
 * GET:  Returns stored params for a given address.
 *       The Acurast processor calls this at startup to sync into _STD_.storage.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getStore } from '@netlify/blobs';

const MAINNET_KEEPER = process.env.NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS || '';
const TESTNET_KEEPER = process.env.NEXT_PUBLIC_TESTNET_KEEPER_ADDRESS || process.env.NEXT_PUBLIC_KEEPER_ADDRESS || '';

function getConfig(chainId: number) {
  return {
    keeper: chainId === 8453 ? MAINNET_KEEPER : TESTNET_KEEPER,
    chainId: chainId === 8453 ? 8453 : 84532,
  };
}

const localStrategyStore = new Map<string, any>();

async function getStrategyStore() {
  try {
    return getStore('yieldsense-strategies');
  } catch (err: any) {
    if (err.name === 'MissingBlobsEnvironmentError') {
      return null; // Fall back to local in-memory store
    }
    throw err;
  }
}


const TYPES = {
  StrategyParams: [
    { name: 'stopLossPrice', type: 'string' },
    { name: 'gridUpper', type: 'string' },
    { name: 'gridLower', type: 'string' },
    { name: 'rebalanceInterval', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

interface StoredStrategy {
  stopLossPrice: number;
  gridUpper: number;
  gridLower: number;
  rebalanceInterval: number;
  signer: string;
  signature: string;
  timestamp: number;
  chainId?: number;
}

// ─── POST /api/strategy ───────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: StoredStrategy;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { stopLossPrice, gridUpper, gridLower, rebalanceInterval, signer, signature, timestamp, chainId } = body;

  if (!signer || !signature || !timestamp) {
    return NextResponse.json({ error: 'Missing required fields: signer, signature, timestamp' }, { status: 400 });
  }

  const config = getConfig(Number(chainId || 84532));

  // EIP-712 domain — must exactly match the processor's domain in processor.ts
  const domain = {
    name: 'YieldSense',
    version: '1',
    chainId: config.chainId,
    verifyingContract: config.keeper as `0x${string}`,
  };

  // Reconstruct EIP-712 value object (all numeric fields serialized as strings to match frontend)
  const value = {
    stopLossPrice: String(stopLossPrice),
    gridUpper: String(gridUpper),
    gridLower: String(gridLower),
    rebalanceInterval: String(rebalanceInterval),
    timestamp,
  };

  // Verify the EIP-712 signature — recovers the signer from the typed data
  let recoveredSigner: string;
  try {
    recoveredSigner = ethers.verifyTypedData(domain, TYPES, value, signature);
  } catch (err) {
    return NextResponse.json({ error: 'Signature verification failed', detail: String(err) }, { status: 422 });
  }

  if (recoveredSigner.toLowerCase() !== signer.toLowerCase()) {
    return NextResponse.json(
      { error: 'Signature mismatch', expected: signer, recovered: recoveredSigner },
      { status: 403 }
    );
  }

  // Signature valid — persist to Netlify Blobs or local store
  const blobs = await getStrategyStore();
  if (blobs) {
    await blobs.setJSON(signer.toLowerCase(), body);
  } else {
    localStrategyStore.set(signer.toLowerCase(), body);
  }

  return NextResponse.json({ ok: true, signer, timestamp }, { status: 200 });
}

// ─── GET /api/strategy?address=0x... ─────────────────────────────────────────
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'Missing ?address param' }, { status: 400 });
  }

  const blobs = await getStrategyStore();
  const params = blobs
    ? await blobs.get(address.toLowerCase(), { type: 'json' })
    : localStrategyStore.get(address.toLowerCase());

  if (!params) {
    return NextResponse.json({ error: 'No strategy params found for this address' }, { status: 404 });
  }

  return NextResponse.json(params);
}
