import { NextRequest, NextResponse } from 'next/server';
import type { ChainStateSnapshot, ExecutionJob, ExecutionJobStatus } from '@/lib/gridTypes';

const allowedStatuses = new Set<ExecutionJobStatus>([
  'pending',
  'claimed',
  'stale',
  'submitted',
  'confirmed',
  'reverted',
  'failed',
  'expired',
  'cancelled',
]);

type QueueStore = {
  jobs: Map<string, ExecutionJob>;
  idempotency: Map<string, string>;
};

const globalForGridQueue = globalThis as typeof globalThis & {
  __yieldsenseGridQueue?: QueueStore;
};

const store: QueueStore =
  globalForGridQueue.__yieldsenseGridQueue ||
  (globalForGridQueue.__yieldsenseGridQueue = {
    jobs: new Map(),
    idempotency: new Map(),
  });

function isSnapshot(value: unknown): value is ChainStateSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ChainStateSnapshot>;
  return (
    typeof snapshot.strategyVersion === 'number' &&
    typeof snapshot.currentGridLevel === 'number' &&
    typeof snapshot.lastExecutionAt === 'string' &&
    typeof snapshot.quoteBalance === 'string' &&
    typeof snapshot.baseBalance === 'string'
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const strategyId = searchParams.get('strategyId');
  const status = searchParams.get('status') as ExecutionJobStatus | null;

  const jobs = Array.from(store.jobs.values()).filter((job) => {
    if (strategyId && job.strategyId !== strategyId) return false;
    if (status && job.status !== status) return false;
    return true;
  });

  return NextResponse.json({ jobs });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const {
    strategyId,
    pairId,
    side,
    gridLevel,
    idempotencyKey,
    chainStateSnapshot,
    status,
  } = body as Partial<ExecutionJob>;

  if (!strategyId || !pairId || (side !== 'buy' && side !== 'sell') || typeof gridLevel !== 'number') {
    return NextResponse.json({ error: 'Missing required execution job fields' }, { status: 400 });
  }

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return NextResponse.json({ error: 'Missing idempotencyKey' }, { status: 400 });
  }

  if (!isSnapshot(chainStateSnapshot)) {
    return NextResponse.json({ error: 'Missing valid chainStateSnapshot' }, { status: 400 });
  }
  if (status && !allowedStatuses.has(status)) {
    return NextResponse.json({ error: 'Invalid job status' }, { status: 400 });
  }

  const existingId = store.idempotency.get(idempotencyKey);
  if (existingId) {
    return NextResponse.json({ job: store.jobs.get(existingId), duplicate: true });
  }

  const now = new Date().toISOString();
  const job: ExecutionJob = {
    id: crypto.randomUUID(),
    strategyId,
    pairId,
    side,
    gridLevel,
    idempotencyKey,
    chainStateSnapshot,
    status: status || 'pending',
    attempts: status ? 1 : 0,
    createdAt: now,
  };
  if (status === 'claimed') job.claimedAt = now;
  if (status === 'submitted') job.submittedAt = now;
  if (status === 'confirmed') {
    job.claimedAt = now;
    job.submittedAt = now;
    job.confirmedAt = now;
  }
  if (typeof body.txHash === 'string') job.txHash = body.txHash as ExecutionJob['txHash'];
  if (typeof body.gasUsed === 'string') job.gasUsed = body.gasUsed;
  if (typeof body.gasCostQuote === 'string') job.gasCostQuote = body.gasCostQuote;
  if (typeof body.revertReason === 'string') job.revertReason = body.revertReason;
  if (typeof body.error === 'string') job.error = body.error;

  store.jobs.set(job.id, job);
  store.idempotency.set(idempotencyKey, job.id);

  return NextResponse.json({ job, duplicate: false }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { id, status } = body as { id?: string; status?: ExecutionJobStatus };
  if (!id || !status || !allowedStatuses.has(status)) {
    return NextResponse.json({ error: 'Invalid job id or status' }, { status: 400 });
  }

  const job = store.jobs.get(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const now = new Date().toISOString();
  job.status = status;
  if (status === 'claimed') {
    job.claimedAt = now;
    job.attempts += 1;
  }
  if (status === 'submitted') job.submittedAt = now;
  if (status === 'confirmed') job.confirmedAt = now;

  if (typeof body.txHash === 'string') job.txHash = body.txHash;
  if (typeof body.gasUsed === 'string') job.gasUsed = body.gasUsed;
  if (typeof body.gasCostQuote === 'string') job.gasCostQuote = body.gasCostQuote;
  if (typeof body.staleReason === 'string') job.staleReason = body.staleReason;
  if (typeof body.revertReason === 'string') job.revertReason = body.revertReason;
  if (typeof body.error === 'string') job.error = body.error;

  store.jobs.set(id, job);
  return NextResponse.json({ job });
}
