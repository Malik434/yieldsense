'use client';

import { X, Wallet, ShieldCheck } from 'lucide-react';
import { useConnect } from 'wagmi';
import { useEffect, useState } from 'react';

interface WalletSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WalletSelectionModal({ isOpen, onClose }: WalletSelectionModalProps) {
  const { connect, connectors } = useConnect();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!isOpen || !mounted) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-[#030605]/80 backdrop-blur-md animate-fade-in">
      <div className="ys-card max-w-sm w-full p-10 relative overflow-hidden border-[#C2E812]/20">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#C2E812] to-[#00FFA3]" />
        
        <button 
          onClick={onClose}
          className="absolute top-6 right-6 p-2 rounded-xl bg-white/5 border border-white/10 text-[#484F58] hover:text-[#F5F7FA] transition-all"
        >
          <X size={20} />
        </button>

        <div className="flex flex-col gap-8">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#C2E812]/10 border border-[#C2E812]/20 flex items-center justify-center">
              <ShieldCheck size={32} className="text-[#C2E812]" />
            </div>
            <div>
              <h2 className="text-2xl font-heading font-bold text-[#F5F7FA] tracking-tight">Connect Identity</h2>
              <p className="text-[10px] font-mono text-[#8B949E] uppercase tracking-widest mt-1">Select your secure enclave access</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector });
                  onClose();
                }}
                className="group flex items-center justify-between p-5 rounded-2xl bg-white/5 border border-white/10 hover:bg-[#C2E812]/5 hover:border-[#C2E812]/30 transition-all text-left"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center group-hover:bg-[#C2E812]/10 transition-colors">
                    <Wallet size={18} className="text-[#8B949E] group-hover:text-[#C2E812]" />
                  </div>
                  <div>
                    <p className="text-sm font-heading font-bold text-[#F5F7FA]">{connector.name}</p>
                    <p className="text-[9px] font-mono text-[#484F58] uppercase tracking-widest group-hover:text-[#8B949E]">
                      {connector.name.includes('Coinbase') ? 'Smart Wallet Ready' : 'Injected Provider'}
                    </p>
                  </div>
                </div>
                <div className="w-6 h-6 rounded-full border border-white/10 flex items-center justify-center group-hover:border-[#C2E812]/50 group-hover:bg-[#C2E812] transition-all">
                  <div className="w-1.5 h-1.5 rounded-full bg-white group-hover:bg-[#030605]" />
                </div>
              </button>
            ))}
          </div>

          <div className="text-center">
            <p className="text-[9px] font-mono text-[#484F58] uppercase tracking-[0.2em] leading-relaxed">
              By connecting, you verify ownership <br /> of strategy parameters on Base.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
