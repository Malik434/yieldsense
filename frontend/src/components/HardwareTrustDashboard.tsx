'use client';

import { ShieldCheck, AlertTriangle, ExternalLink } from 'lucide-react';

interface HardwareTrustDashboardProps {
  processorAddress: string;
}

/**
 * Hardware Trust Dashboard
 *
 * Honest status: Permissionless on-chain P-256 attestation (attestProcessor) requires
 * the Acurast CA public key to be configured in the contract via setAttestationRoot(),
 * plus a real P-256 certificate from the Acurast TEE — neither of which is available
 * through the browser.
 *
 * For the MVP, processor attestation is managed by the protocol admin via
 * ownerAttestProcessor(processorAddress). Contact the YieldSense team with your
 * processor address after provisioning your Acurast Cargo job.
 *
 * The previous UI that simulated a WebSocket attestation fetch and submitted
 * hardcoded fake certificate values has been removed because it always produced
 * a contract revert and misrepresented the security guarantees to users.
 */
export function HardwareTrustDashboard({ processorAddress }: HardwareTrustDashboardProps) {
  if (!processorAddress) return null;

  return (
    <div className="cyber-card p-6 flex flex-col gap-4 mt-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: '#a78bfa' }} />
          <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#a78bfa', letterSpacing: '0.15em' }}>
            HARDWARE ATTESTATION
          </span>
        </div>
        <span className="font-mono text-[9px] text-[#64748b]">ADMIN-MANAGED</span>
      </div>

      {/* Processor address */}
      <div className="p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="font-mono text-[10px] text-[#64748b] mb-1">ASSIGNED PROCESSOR</p>
        <p className="font-mono text-xs break-all" style={{ color: '#e2e8f0' }}>{processorAddress}</p>
      </div>

      {/* Honest attestation status */}
      <div
        className="flex items-start gap-3 rounded-lg p-4"
        style={{ background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.2)' }}
      >
        <AlertTriangle size={14} style={{ color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[10px] font-semibold" style={{ color: '#a78bfa' }}>
            ATTESTATION MANAGED BY PROTOCOL ADMIN
          </p>
          <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#64748b' }}>
            Permissionless on-chain TEE attestation requires the Acurast CA P-256 root key
            to be configured and a real hardware certificate chain from your device.
            Full integration is in progress.
          </p>
          <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#64748b' }}>
            For this MVP, the protocol admin calls{' '}
            <code className="px-1 rounded" style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>
              ownerAttestProcessor({processorAddress.slice(0, 10)}…)
            </code>{' '}
            on the keeper contract to whitelist your processor.
          </p>
          <p className="font-mono text-[10px]" style={{ color: '#64748b' }}>
            After attestation: assign your processor via the provisioning box above,
            then your strategy will execute.
          </p>
        </div>
      </div>

      {/* Link to Acurast docs */}
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
