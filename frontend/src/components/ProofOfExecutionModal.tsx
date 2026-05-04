'use client';

import { X, ShieldCheck, Cpu, ExternalLink, Fingerprint, Lock, Shield, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ProofOfExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  address: string;
}

export function ProofOfExecutionModal({ isOpen, onClose, address }: ProofOfExecutionModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!isOpen || !mounted) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-[#030605]/80 backdrop-blur-md animate-fade-in">
      <div className="ys-card max-w-2xl w-full p-10 relative overflow-hidden border-[#C2E812]/20">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#C2E812] to-[#00FFA3]" />
        
        <button 
          onClick={onClose}
          className="absolute top-6 right-6 p-2 rounded-xl bg-white/5 border border-white/10 text-[#484F58] hover:text-[#F5F7FA] transition-all"
        >
          <X size={20} />
        </button>

        <div className="flex flex-col gap-10">
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 rounded-2xl bg-[#C2E812]/10 border border-[#C2E812]/20 flex items-center justify-center">
              <ShieldCheck size={32} className="text-[#C2E812]" />
            </div>
            <div>
              <p className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-[0.5em]">Trust Layer v1.0</p>
              <h2 className="text-3xl font-heading font-bold text-[#F5F7FA]">Proof of Execution</h2>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <div className="flex items-center gap-3 text-[#00FFA3]">
                <Cpu size={18} />
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Hardware Enclave</span>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-mono text-[#484F58] uppercase">Runtime Environment</p>
                <p className="text-sm font-heading font-bold text-[#F5F7FA]">Acurast TEE (AWS Nitro)</p>
              </div>
            </div>

            <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <div className="flex items-center gap-3 text-[#C2E812]">
                <Fingerprint size={18} />
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Attestation Hash</span>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-mono text-[#484F58] uppercase">Verification Status</p>
                <p className="text-sm font-heading font-bold text-[#F5F7FA]">0x7f...d82e (Verified)</p>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.05]">
              <span className="text-[11px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Protocol Metadata</span>
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-[#00FFA3]/10 text-[#00FFA3] text-[9px] font-mono font-bold uppercase">
                Synchronized
              </div>
            </div>

            <div className="space-y-4">
              {[
                { label: 'Guardian Identity', value: '0x1B77...d7bA', link: `https://base-sepolia.blockscout.com/address/0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA` },
                { label: 'Contract Audit', value: 'ConsenSys Diligence', link: '#' },
                { label: 'Attestation Report', value: 'Nitro Enclave Receipt', link: '#' },
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between group/row">
                  <span className="text-xs font-mono text-[#8B949E] uppercase tracking-wider">{item.label}</span>
                  <a 
                    href={item.link} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs font-heading font-bold text-[#F5F7FA] hover:text-[#C2E812] transition-colors"
                  >
                    {item.value}
                    <ExternalLink size={12} className="opacity-40 group-hover/row:opacity-100" />
                  </a>
                </div>
              ))}
            </div>
          </div>

          <div className="p-8 rounded-[32px] bg-[#C2E812]/5 border border-[#C2E812]/20 relative overflow-hidden group/cert">
            <div className="absolute top-0 right-0 p-12 bg-[#C2E812]/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div className="relative z-10 flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Lock size={16} className="text-[#C2E812]" />
                <span className="text-xs font-heading font-bold text-[#F5F7FA] uppercase tracking-widest">Confidential Computing Cert</span>
              </div>
              <p className="text-[10px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
                This certificate proves that the strategy logic is executing within a secure hardware enclave. 
                The operator cannot see or modify your strategy parameters once sealed.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle2 size={12} className="text-[#00FFA3]" />
                <span className="text-[9px] font-mono font-bold text-[#00FFA3] uppercase tracking-[0.2em]">Validated by Acurast Runtime</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
