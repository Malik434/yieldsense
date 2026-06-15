'use client';

import { useEffect, useState } from 'react';
import { Cpu, Loader2, Power, RefreshCw } from 'lucide-react';
import { useNetwork } from '@/providers/NetworkProvider';

type YieldLease = {
  enabled: boolean;
  state: string;
  currentDeploymentId?: string;
  currentProcessorAddress?: string;
  leaseExpiresAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
};

type ApiResponse = {
  lease?: YieldLease;
  action?: string;
  message?: string;
  error?: string;
};

function short(value?: string) {
  if (!value) return 'Not set';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function YieldOrchestrationControl() {
  const { chainId } = useNetwork();
  const [lease, setLease] = useState<YieldLease | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    const response = await fetch(`/api/yield-orchestrator?chainId=${chainId}`);
    const body = (await response.json().catch(() => ({}))) as ApiResponse;
    if (!response.ok) throw new Error(body.error || `Yield orchestrator returned ${response.status}`);
    setLease(body.lease ?? null);
  };

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [chainId]);

  const setEnabled = async (enabled: boolean) => {
    setBusy(enabled ? 'Starting' : 'Stopping');
    setError('');
    try {
      const response = await fetch(`/api/yield-orchestrator?chainId=${chainId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok) throw new Error(body.error || `Yield orchestrator returned ${response.status}`);
      setLease(body.lease ?? null);
      if (body.message) setError(body.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    setBusy('Refreshing');
    try {
      await load();
    } finally {
      setBusy('');
    }
  };

  const enabled = lease?.enabled ?? false;

  return (
    <div className="ys-card flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Cpu size={16} className="shrink-0 text-[#00FFA3]" />
          <div className="min-w-0">
            <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
              Yield Processor Orchestration
            </p>
            <p className="mt-1 truncate text-sm font-heading font-bold text-[#F5F7FA]">
              {enabled ? `Enabled | ${lease?.state ?? 'unknown'}` : 'Disabled'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            className="ys-btn-secondary h-10 px-4 text-[10px]"
            disabled={Boolean(busy)}
            onClick={refresh}
          >
            {busy === 'Refreshing' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <button
            className={enabled ? 'ys-btn-secondary h-10 px-4 text-[10px]' : 'ys-btn-primary h-10 px-4 text-[10px]'}
            disabled={Boolean(busy)}
            onClick={() => setEnabled(!enabled)}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {enabled ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 text-[10px] font-mono font-bold uppercase tracking-widest sm:grid-cols-4">
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[#484F58]">Processor</p>
          <p className="mt-1 truncate text-[#F5F7FA]">{short(lease?.currentProcessorAddress)}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[#484F58]">Deployment</p>
          <p className="mt-1 truncate text-[#F5F7FA]">{lease?.currentDeploymentId || 'Not set'}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[#484F58]">Healthy</p>
          <p className="mt-1 truncate text-[#F5F7FA]">{lease?.lastHealthyAt ? new Date(lease.lastHealthyAt).toLocaleString() : 'No telemetry'}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[#484F58]">Expires</p>
          <p className="mt-1 truncate text-[#F5F7FA]">{lease?.leaseExpiresAt ? new Date(lease.leaseExpiresAt).toLocaleDateString() : 'Not leased'}</p>
        </div>
      </div>

      {(error || lease?.lastError) && (
        <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-[10px] font-mono font-bold uppercase tracking-widest text-amber-200">
          {error || lease?.lastError}
        </div>
      )}
    </div>
  );
}
