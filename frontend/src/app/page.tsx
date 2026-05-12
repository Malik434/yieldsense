'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useAccount, useReadContract, useBlockNumber } from 'wagmi';
import { formatUnits } from 'viem';
import { useNetwork } from '@/providers/NetworkProvider';

import { KEEPER_ABI, OPERATOR_ADDRESS } from '@/lib/contracts';
import { Header } from '@/components/Header';
import { DepositModule } from '@/components/DepositModule';
import { ConfidentialStrategyBox } from '@/components/ConfidentialStrategyBox';
import { PnlChart } from '@/components/PnlChart';
import { TransactionHistory } from '@/components/TransactionHistory';
import { WithdrawModule } from '@/components/WithdrawModule';
import { PortfolioTicker } from '@/components/PortfolioTicker';
import { TestingSuite } from '@/components/TestingSuite';
import {
  Activity,
  Cpu,
  ArrowRight
} from 'lucide-react';

interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number;
  yieldIndexerCheckpointBlock: number | null;
  rewardAprEwm: { mean: number; variance: number; lastTimestamp: number } | null;
  gridTradesExecuted?: number;
  lastGridTradeAt?: number | null;
  totalRealizedProfitUsd?: number;
  unrealizedYieldUsd?: number;
  error?: string;
  defaultState?: boolean;
}

interface ConsensusData {
  geckoTerminal: number;
  dexScreener: number;
  rpc: number;
  consensus: number;
}

interface OnchainAudit {
  principalUsd: number;
  userProfitCreditedUsd: number;
  totalProfitCreditedUsd: number;
}

function SectionHeading({ id, label, sublabel }: { id: string; label: string; sublabel: string }) {
  return (
    <div id={id} className="mb-8 pt-16 group sm:mb-12 sm:pt-24">
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-2xl sm:text-3xl font-heading font-bold tracking-tighter text-[#F5F7FA]">
          {label}
        </h2>
        <div className="h-px flex-1 bg-white/[0.05]" />
      </div>
      <p className="text-[10px] sm:text-xs font-mono font-bold text-[#484F58] uppercase tracking-[0.25em] sm:tracking-[0.4em]">
        {sublabel}
      </p>
    </div>
  );
}

export default function CommandCenter() {
  const { address } = useAccount();
  const { config, chainId } = useNetwork();
  const KEEPER_ADDRESS = config.keeper;

  const [vaultState, setVaultState] = useState<WorkerState | null>(null);
  const [consensus, setConsensus] = useState<ConsensusData | null>(null);
  const [onchainAudit, setOnchainAudit] = useState<OnchainAudit | null>(null);

  const fetchVaultState = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}&chainId=${chainId}`);
      if (res.ok) {
        const data = await res.json();
        setVaultState(data);
      }
    } catch { }
  }, [chainId]);

  const fetchConsensus = useCallback(async () => {
    try {
      const res = await fetch(`/api/consensus?chainId=${chainId}`);
      if (res.ok) {
        const data = await res.json();
        setConsensus(data);
      }
    } catch { }
  }, [chainId]);

  const fetchOnchainAudit = useCallback(async () => {
    if (!address) {
      setOnchainAudit(null);
      return;
    }

    try {
      const res = await fetch(`/api/onchain-audit?userAddress=${address}&chainId=${chainId}`);
      if (res.ok) {
        const data = await res.json();
        setOnchainAudit(data);
      }
    } catch { }
  }, [address, chainId]);

  useEffect(() => {
    const initialVaultTimeout = setTimeout(fetchVaultState, 0);
    const initialConsensusTimeout = setTimeout(fetchConsensus, 0);
    const initialAuditTimeout = setTimeout(fetchOnchainAudit, 0);
    const vaultInterval = setInterval(fetchVaultState, 10_000);
    const consensusInterval = setInterval(fetchConsensus, 30_000);
    const auditInterval = setInterval(fetchOnchainAudit, 60_000);
    return () => {
      clearTimeout(initialVaultTimeout);
      clearTimeout(initialConsensusTimeout);
      clearTimeout(initialAuditTimeout);
      clearInterval(vaultInterval);
      clearInterval(consensusInterval);
      clearInterval(auditInterval);
    };
  }, [fetchVaultState, fetchConsensus, fetchOnchainAudit]);

  const { data: blockNumber } = useBlockNumber({ watch: true });

  const { data: maxWithdraw, refetch: refetchUserData } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!KEEPER_ADDRESS },
  });

  const { data: userSharesRaw, refetch: refetchUserShares } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!KEEPER_ADDRESS },
  });

  const { data: totalSharesRaw } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'totalSupply',
    query: { enabled: !!KEEPER_ADDRESS },
  });

  const { data: totalAssetsRaw } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'totalAssets',
    query: { enabled: !!KEEPER_ADDRESS },
  });

  useEffect(() => {
    if (blockNumber) {
      refetchUserData();
      refetchUserShares();
    }
  }, [blockNumber, refetchUserData, refetchUserShares]);

  const balance = maxWithdraw ? parseFloat(formatUnits(maxWithdraw as bigint, 6)) : 0;
  const totalShares = totalSharesRaw ? parseFloat(formatUnits(totalSharesRaw as bigint, 6)) : 0;
  const globalTvl = totalAssetsRaw ? parseFloat(formatUnits(totalAssetsRaw as bigint, 6)) : 0;
  const userShares = userSharesRaw ? parseFloat(formatUnits(userSharesRaw as bigint, 6)) : 0;

  const vaultShareFraction: number =
    totalShares > 0 && userShares > 0
      ? Math.min(userShares / totalShares, 1)
      : balance > 0 ? 1 : 0;

  const vaultUnrealized = vaultState?.unrealizedYieldUsd ?? 0;
  const userProfit = onchainAudit?.userProfitCreditedUsd ?? 0;
  const userPrincipal = onchainAudit?.principalUsd ?? balance;
  const userUnrealized = vaultUnrealized * vaultShareFraction;

  const isHealthy = vaultState?.apiFailureStreak === 0 && !vaultState?.defaultState;
  const isWarning = (vaultState?.apiFailureStreak ?? 0) > 0 && (vaultState?.apiFailureStreak ?? 0) < 3;

  const prevApr =
    consensus?.consensus ??
    (vaultState?.previousApr != null ? Math.round(vaultState.previousApr * 10_000) : null);

  return (
    <div className="min-h-screen">
      <Header isHealthy={!!isHealthy} isWarning={!!isWarning} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-28 sm:pb-40">
        <div className="pt-8 sm:pt-12 mb-10 sm:mb-16">
          <PortfolioTicker
            balance={balance}
            unrealizedYield={userUnrealized}
            totalRealized={userProfit}
            apr={prevApr != null ? prevApr / 100 : 0}
            globalTvl={globalTvl}
          />
        </div>

        <div className="mb-14 sm:mb-20 animate-fade-in">
          <div className={`
            ys-card p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-[#0B0F0D]/60
            ${isHealthy ? 'border-[#C2E812]/10' : isWarning ? 'border-amber-500/10' : 'border-[#FF4466]/10'}
          `}>
            <div className="flex items-center gap-5">
              <div className="relative">
                <div className={`status-dot ${isHealthy ? 'bg-[#C2E812]' : isWarning ? 'bg-amber-400' : 'bg-[#FF4466]'}`} />
              </div>
              <span className="font-heading font-bold text-sm tracking-tight text-[#F5F7FA] uppercase">
                {isHealthy ? 'Autonomous Guardian — Active' : isWarning ? 'Oracle Synchronization Degradation' : 'Hardware Signal Lost'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-5 sm:gap-10">
              <div className="flex items-center gap-3">
                <Activity size={16} className="text-[#C2E812]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Trades: <span className="text-[#F5F7FA]">{vaultState?.gridTradesExecuted ?? 0}</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Cpu size={16} className="text-[#00FFA3]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Checkpoint: <span className="text-[#F5F7FA]">{vaultState?.yieldIndexerCheckpointBlock ?? '0'}</span>
                </span>
              </div>
              {vaultState?.lastDecisionReason && (
                <div className="px-4 py-1.5 rounded-xl bg-white/5 border border-white/10 text-[10px] font-mono text-[#8B949E] font-bold tracking-widest uppercase">
                  {vaultState.lastDecisionReason}
                </div>
              )}
            </div>
          </div>
        </div>

        <SectionHeading
          id="command-center"
          label="Vault Allocation"
          sublabel="Principal control & parameterization"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-10 mb-16 sm:mb-24 animate-fade-in">
          <DepositModule />
          <ConfidentialStrategyBox />
        </div>

        <SectionHeading
          id="live-alpha"
          label="Activity & Audit"
          sublabel="Real-time verified yield engine"
        />
        <div className="animate-fade-in space-y-10" style={{ animationDelay: '0.1s' }}>
          <PnlChart
            currentBalance={balance}
            initialDeposit={userPrincipal}
            totalRealized={userProfit}
            unrealizedYield={userUnrealized}
            userAddress={OPERATOR_ADDRESS}
            portfolioAddress={address}
            chainId={chainId}
            vaultShareFraction={vaultShareFraction}
          />
          <TransactionHistory />
          <TestingSuite />
        </div>

        <SectionHeading
          id="exit-flow"
          label="Liquidity Exit"
          sublabel="Vault withdrawal & settlement"
        />
        <div className="max-w-3xl mx-auto animate-fade-in" style={{ animationDelay: '0.2s' }}>
          <WithdrawModule />
        </div>

        <footer className="mt-32 sm:mt-60 pt-16 sm:pt-20 border-t border-white/[0.05]">
          <div className="flex flex-col md:flex-row items-center justify-between gap-16">
            <div className="flex flex-col gap-8">
              <div className="flex items-center gap-5">
                <div className="relative w-12 h-12 overflow-hidden rounded-2xl border border-[#C2E812]/20 bg-[#C2E812]/5 shadow-lg shadow-[#C2E812]/10">
                  <Image
                    src="/YieldSenseLogo.png"
                    alt="YieldSense"
                    fill
                    sizes="48px"
                    className="object-cover"
                  />
                </div>
                <div>
                  <span className="font-heading font-bold text-3xl text-[#F5F7FA]">YieldSense</span>
                  <p className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-[0.5em] mt-1">Autonomous Systems</p>
                </div>
              </div>
              <p className="text-xs font-mono text-[#484F58] max-w-sm leading-relaxed uppercase tracking-[0.2em]">
                Protocol-level security powered by Acurast TEE. <br />
                Strategy parameters are encrypted and verified at runtime in secure hardware enclaves.
              </p>
            </div>

            <div className="flex flex-col items-end gap-8">
              <a
                href={`${config.explorer}/address/${KEEPER_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-4 text-[11px] font-mono font-bold text-[#8B949E] hover:text-[#C2E812] transition-all duration-500 uppercase tracking-[0.4em]"
              >
                Explorer Verified
                <ArrowRight size={16} className="group-hover:translate-x-3 transition-transform duration-500" />
              </a>
              <div className="px-6 py-3 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-xs font-mono font-bold text-[#484F58] tracking-widest">
                {KEEPER_ADDRESS}
              </div>
            </div>
          </div>

          <div className="mt-24 text-center">
            <span className="text-[10px] font-mono text-[#484F58] tracking-[0.6em] uppercase font-bold opacity-40">
              © 2024 YieldSense Autonomous Guardian
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
