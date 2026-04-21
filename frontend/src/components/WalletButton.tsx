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
        className="relative flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm font-semibold tracking-wider transition-all duration-200"
        style={{
          background: 'linear-gradient(135deg, rgba(0,255,159,0.12), rgba(0,212,255,0.08))',
          border: '1px solid rgba(0,255,159,0.4)',
          color: '#00ff9f',
          animation: 'border-glow 2.5s ease-in-out infinite',
        }}
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
      className="flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm font-semibold tracking-wider transition-all duration-200"
      style={{
        background: hovered
          ? 'rgba(255,68,102,0.1)'
          : 'rgba(0,255,159,0.06)',
        border: hovered
          ? '1px solid rgba(255,68,102,0.5)'
          : '1px solid rgba(0,255,159,0.25)',
        color: hovered ? '#ff4466' : '#00ff9f',
      }}
    >
      {hovered ? (
        <>
          <LogOut size={14} />
          DISCONNECT
        </>
      ) : (
        <>
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: '#00ff9f', boxShadow: '0 0 8px #00ff9f' }}
          />
          {address?.slice(0, 6)}...{address?.slice(-4)}
          <ChevronDown size={12} />
        </>
      )}
    </button>
  );
}
