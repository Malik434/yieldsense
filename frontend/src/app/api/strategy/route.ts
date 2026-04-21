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
import path from 'path';
import fs from 'fs';

const STRATEGY_FILE = path.resolve(process.cwd(), '.strategy-params.json');
const KEEPER_ADDRESS = process.env.NEXT_PUBLIC_KEEPER_ADDRESS ?? '';

// EIP-712 domain + types — must exactly match the frontend and processor
const DOMAIN = {
  name: 'YieldSense',
  version: '1',
  chainId: 84532, // Base Sepolia
  verifyingContract: KEEPER_ADDRESS as `0x${string}`,
};

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
}

function readStore(): Record<string, StoredStrategy> {
  try {
    if (!fs.existsSync(STRATEGY_FILE)) return {};
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, StoredStrategy>): void {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── POST /api/strategy ───────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: StoredStrategy;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { stopLossPrice, gridUpper, gridLower, rebalanceInterval, signer, signature, timestamp } = body;

  if (!signer || !signature || !timestamp) {
    return NextResponse.json({ error: 'Missing required fields: signer, signature, timestamp' }, { status: 400 });
  }

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
    recoveredSigner = ethers.verifyTypedData(DOMAIN, TYPES, value, signature);
  } catch (err) {
    return NextResponse.json({ error: 'Signature verification failed', detail: String(err) }, { status: 422 });
  }

  if (recoveredSigner.toLowerCase() !== signer.toLowerCase()) {
    return NextResponse.json(
      { error: 'Signature mismatch', expected: signer, recovered: recoveredSigner },
      { status: 403 }
    );
  }

  // Signature valid — persist
  const store = readStore();
  store[signer.toLowerCase()] = body;
  writeStore(store);

  return NextResponse.json({ ok: true, signer, timestamp }, { status: 200 });
}

// ─── GET /api/strategy?address=0x... ─────────────────────────────────────────
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'Missing ?address param' }, { status: 400 });
  }

  const store = readStore();
  const params = store[address.toLowerCase()];

  if (!params) {
    return NextResponse.json({ error: 'No strategy params found for this address' }, { status: 404 });
  }

  return NextResponse.json(params);
}
