'use client';

import { useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import { useAccount, useDisconnect } from 'wagmi';
import { Cpu, Shield, LogOut, Wallet } from 'lucide-react';
import { ProofOfExecutionModal } from './ProofOfExecutionModal';
import { WalletSelectionModal } from './WalletSelectionModal';
import { NetworkToggle } from './NetworkToggle';
import { useNetwork } from '@/providers/NetworkProvider';

interface HeaderProps {
  isHealthy?: boolean;
  isWarning?: boolean;
}

function useHydrated() {
  return useSyncExternalStore(
    (onStoreChange) => {
      const timeout = setTimeout(onStoreChange, 0);
      return () => clearTimeout(timeout);
    },
    () => true,
    () => false
  );
}

export function Header({ isHealthy = true, isWarning = false }: HeaderProps) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { config } = useNetwork();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const hydrated = useHydrated();
  const showConnectedWallet = hydrated && isConnected;

  const handleWalletAction = () => {
    if (showConnectedWallet) {
      disconnect();
    } else {
      setIsWalletModalOpen(true);
    }
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full bg-[#030605]/80 backdrop-blur-xl border-b border-white/[0.03]">
        <div className="max-w-7xl mx-auto px-6 h-24 flex items-center justify-between">
          {/* Logo & Network */}
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-4">
              <div className="relative w-11 h-11 overflow-hidden rounded-2xl border border-[#C2E812]/20 bg-[#C2E812]/5 shadow-lg shadow-[#C2E812]/10">
                <Image
                  src="/YieldSenseLogo.png"
                  alt="YieldSense"
                  fill
                  sizes="44px"
                  className="object-cover"
                  priority
                />
              </div>
              <div className="flex flex-col">
                <span className="font-heading font-bold text-2xl text-[#F5F7FA] tracking-tight">YieldSense</span>
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${config.name.includes('Mainnet') ? 'bg-[#C2E812]' : 'bg-[#00FFA3]'} animate-pulse`} />
                  <span className="text-[10px] font-mono font-bold text-[#8B949E] uppercase tracking-widest">{config.name}</span>
                </div>
              </div>
            </div>

            <div className="h-8 w-px bg-white/[0.08] mx-2 hidden md:block" />
            
            <div className="hidden md:block">
              <NetworkToggle />
            </div>
          </div>

          {/* Actions & Status */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsModalOpen(true)}
              className="hidden lg:flex items-center gap-2.5 px-5 py-2.5 rounded-xl bg-[#C2E812]/5 border border-[#C2E812]/10 hover:bg-[#C2E812]/10 hover:border-[#C2E812]/30 text-[#C2E812] transition-all group"
            >
              <Shield size={16} className="group-hover:scale-110 transition-transform" />
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Verify Agent</span>
            </button>

            <div className="h-10 w-px bg-white/[0.05] mx-2 hidden md:block" />

            {/* Acurast Status */}
            <div className="hidden md:flex items-center gap-4 px-5 py-2.5 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className={`w-2.5 h-2.5 rounded-full ${isHealthy ? 'bg-[#00FFA3]' : isWarning ? 'bg-amber-400' : 'bg-[#FF4466]'} shadow-lg ${isHealthy ? 'shadow-[#00FFA3]/20' : ''}`} />
                  <div className={`absolute -inset-1 rounded-full ${isHealthy ? 'bg-[#00FFA3]/20' : ''} animate-ping`} />
                </div>
                <span className="text-[10px] font-mono font-bold text-[#F5F7FA] uppercase tracking-widest">
                  {isHealthy ? 'TEE Online' : isWarning ? 'Degraded' : 'Offline'}
                </span>
              </div>
              <div className="w-px h-4 bg-white/10" />
              <div className="flex items-center gap-2">
                <Cpu size={14} className="text-[#8B949E]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Acurast Enclave</span>
              </div>
            </div>

            {/* Account */}
            <button
              onClick={handleWalletAction}
              className="flex items-center gap-3 pl-2 group transition-all"
            >
              <div className="flex flex-col items-end hidden sm:flex">
                <span className={`text-xs font-heading font-bold transition-colors ${showConnectedWallet ? 'text-[#F5F7FA] group-hover:text-[#FF4466]' : 'text-[#C2E812]'}`}>
                  {showConnectedWallet ? `${address?.slice(0, 6)}...${address?.slice(-4)}` : 'Connect Wallet'}
                </span>
                <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-1">
                  {showConnectedWallet ? (
                    <><LogOut size={8} className="group-hover:text-[#FF4466]" /> Disconnect</>
                  ) : (
                    <><Wallet size={8} className="text-[#C2E812]" /> Setup Identity</>
                  )}
                </span>
              </div>
              <div className={`w-10 h-10 rounded-2xl p-[1px] transition-all duration-500 ${showConnectedWallet ? 'bg-gradient-to-br from-[#C2E812] to-[#00FFA3] group-hover:scale-105' : 'bg-white/10 group-hover:bg-[#C2E812]/20'}`}>
                <div className="w-full h-full rounded-2xl bg-[#030605] flex items-center justify-center overflow-hidden">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${showConnectedWallet ? 'bg-white/10 border border-white/10 text-[#F5F7FA]' : 'bg-[#C2E812]/10 text-[#C2E812]'}`}>
                    {showConnectedWallet && address ? address.slice(2, 3).toUpperCase() : <Wallet size={14} className={!showConnectedWallet ? 'animate-pulse' : ''} />}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
      </header>

      <ProofOfExecutionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        address={address || ''}
      />

      <WalletSelectionModal
        isOpen={isWalletModalOpen}
        onClose={() => setIsWalletModalOpen(false)}
      />
    </>
  );
}
