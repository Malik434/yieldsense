'use client';

import { ShieldCheck, AlertTriangle, ExternalLink } from 'lucide-react';

interface HardwareTrustDashboardProps {
  processorAddress: string;
}

export function HardwareTrustDashboard({ processorAddress }: HardwareTrustDashboardProps) {
  if (!processorAddress) return null;

  return (
    <div className="cyber-card p-6 flex flex-col gap-4 mt-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: '#a78bfa' }} />
          <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#a78bfa', letterSpacing: '0.15em' }}>
            PROCESSOR AUTHORIZATION
          </span>
        </div>
        <span className="font-mono text-[9px] text-[#64748b]">REGISTRY-MANAGED</span>
      </div>

      <div className="p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="font-mono text-[10px] text-[#64748b] mb-1">PROCESSOR ADDRESS</p>
        <p className="font-mono text-xs break-all" style={{ color: '#e2e8f0' }}>{processorAddress}</p>
      </div>

      <div
        className="flex items-start gap-3 rounded-lg p-4"
        style={{ background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.2)' }}
      >
        <AlertTriangle size={14} style={{ color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[10px] font-semibold" style={{ color: '#a78bfa' }}>
            AUTHORIZATION MANAGED BY EXECUTOR REGISTRY
          </p>
          <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#64748b' }}>
            Acurast deployment addresses are replaceable. The protocol owner authorizes the current deployment address
            in ExecutorRegistry with either the YIELD_EXECUTOR or GRID_EXECUTOR role.
          </p>
          <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#64748b' }}>
            For testing, the deployer EOA calls{' '}
            <code className="px-1 rounded" style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>
              registerProcessor({processorAddress.slice(0, 10)}...)
            </code>{' '}
            on ExecutorRegistry.
          </p>
          <p className="font-mono text-[10px]" style={{ color: '#64748b' }}>
            Once authorized, this processor can execute its role without per-user vault bindings.
          </p>
        </div>
      </div>

      <a
        href="https://docs.acurast.com"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 font-mono text-[10px] transition-colors hover:text-[#a78bfa]"
        style={{ color: '#475569' }}
      >
        <ExternalLink size={11} />
        Acurast Cargo documentation
      </a>
    </div>
  );
}
