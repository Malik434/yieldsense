'use client';

import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { Wallet, LogOut, ChevronDown } from 'lucide-react';
import { useState } from 'react';

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [hovered, setHovered] = useState(false);

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: injected() })}
        disabled={isPending}
        className="ys-btn-primary h-10 min-w-[160px]"
      >
        <Wallet size={15} />
        {isPending ? 'CONNECTING...' : 'CONNECT WALLET'}
      </button>
    );
  }

  return (
    <button
      onClick={() => disconnect()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`
        flex items-center gap-2.5 px-4 h-10 rounded-xl font-heading text-xs font-semibold tracking-wider transition-all duration-300
        ${hovered 
          ? 'bg-red-500/10 border-red-500/20 text-red-400' 
          : 'bg-white/[0.03] border-white/[0.06] text-white hover:bg-white/[0.06] hover:border-white/[0.1]'}
        border
      `}
    >
      {hovered ? (
        <>
          <LogOut size={14} />
          DISCONNECT
        </>
      ) : (
        <>
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.5)]" />
          {address?.slice(0, 6)}...{address?.slice(-4)}
          <ChevronDown size={14} className="opacity-40" />
        </>
      )}
    </button>
  );
}
