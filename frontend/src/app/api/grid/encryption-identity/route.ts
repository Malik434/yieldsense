import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import type { GridAttestationEvidence, HexAddress } from '@/lib/gridTypes';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function publicKeyHash(publicKey: string) {
  return `0x${createHash('sha256').update(publicKey).digest('hex')}`;
}

export async function GET() {
  try {
    const publicKey = requiredEnv('GRID_ENCRYPTION_PUBLIC_KEY');
    const processorAddress = requiredEnv('GRID_ENCRYPTION_PROCESSOR_ADDRESS') as HexAddress;
    const codeHash = requiredEnv('GRID_PROCESSOR_CODE_HASH');
    const deploymentHash = requiredEnv('GRID_PROCESSOR_DEPLOYMENT_HASH');
    const issuedAt = process.env.GRID_ATTESTATION_ISSUED_AT || new Date(0).toISOString();

    const body: GridAttestationEvidence = {
      identity: {
        publicKey,
        keyId: process.env.GRID_ENCRYPTION_KEY_ID || publicKeyHash(publicKey),
        attestationId: process.env.GRID_ATTESTATION_ID || deploymentHash,
        codeHash,
        deploymentHash,
        processorAddress,
        validFrom: process.env.GRID_ENCRYPTION_VALID_FROM || issuedAt,
        validUntil: process.env.GRID_ENCRYPTION_VALID_UNTIL || undefined,
        status: (process.env.GRID_ENCRYPTION_STATUS as GridAttestationEvidence['identity']['status']) || 'active',
      },
      evidence: {
        processorAddress,
        codeHash,
        deploymentHash,
        publicKeyHash: publicKeyHash(publicKey),
        issuedAt,
        expiresAt: process.env.GRID_ATTESTATION_EXPIRES_AT || undefined,
      },
    };

    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Grid encryption identity is unavailable',
      },
      { status: 503 },
    );
  }
}
