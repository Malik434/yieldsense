'use client';

import React from 'react';
import { useNetwork } from '@/providers/NetworkProvider';
import { base, baseSepolia } from 'wagmi/chains';
import { Globe, Zap } from 'lucide-react';

export function NetworkToggle() {
  const { chainId, switchNetwork } = useNetwork();

  return (
    <div className="flex p-1 bg-white/[0.03] border border-white/[0.08] rounded-2xl backdrop-blur-md">
      <button
        onClick={() => switchNetwork(base.id)}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-xl transition-all duration-300
          ${chainId === base.id 
            ? 'bg-[#C2E812] text-[#030605] shadow-lg shadow-[#C2E812]/20' 
            : 'text-[#8B949E] hover:text-[#F5F7FA] hover:bg-white/5'}
        `}
      >
        <Globe size={14} className={chainId === base.id ? 'animate-pulse' : ''} />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider">Mainnet</span>
      </button>
      
      <button
        onClick={() => switchNetwork(baseSepolia.id)}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-xl transition-all duration-300
          ${chainId === baseSepolia.id 
            ? 'bg-[#00FFA3] text-[#030605] shadow-lg shadow-[#00FFA3]/20' 
            : 'text-[#8B949E] hover:text-[#F5F7FA] hover:bg-white/5'}
        `}
      >
        <Zap size={14} className={chainId === baseSepolia.id ? 'animate-pulse' : ''} />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider">Testnet</span>
      </button>
    </div>
  );
}
