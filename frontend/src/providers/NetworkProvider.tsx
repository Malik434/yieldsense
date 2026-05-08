'use client';

import React, { createContext, useContext, ReactNode, useEffect, useState } from 'react';
import { useChainId, useSwitchChain, useAccount } from 'wagmi';
import { getContractConfig, CHAIN_CONFIG, DEFAULT_CHAIN_ID } from '@/lib/contracts';

interface NetworkContextType {
  chainId: number;
  config: typeof CHAIN_CONFIG[keyof typeof CHAIN_CONFIG];
  isMainnet: boolean;
  switchNetwork: (chainId: number) => void;
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { isConnected } = useAccount();
  
  // Local state to track preference even if wallet is disconnected
  const [activeChainId, setActiveChainId] = useState<number>(wagmiChainId || DEFAULT_CHAIN_ID);

  useEffect(() => {
    if (wagmiChainId) {
      setActiveChainId(wagmiChainId);
    }
  }, [wagmiChainId]);

  const handleSwitchNetwork = (newChainId: number) => {
    if (isConnected) {
      switchChain({ chainId: newChainId });
    } else {
      setActiveChainId(newChainId);
    }
  };

  const config = getContractConfig(activeChainId);
  const isMainnet = activeChainId === 8453;

  return (
    <NetworkContext.Provider 
      value={{ 
        chainId: activeChainId, 
        config, 
        isMainnet,
        switchNetwork: handleSwitchNetwork 
      }}
    >
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) {
    throw new Error('useNetwork must be used within a NetworkProvider');
  }
  return context;
}
