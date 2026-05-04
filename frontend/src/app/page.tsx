'use client';

import { useEffect, useState } from 'react';
import { useAccount, useReadContract, useBlockNumber } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
import { Header } from '@/components/Header';
import { DepositModule } from '@/components/DepositModule';
import { ConfidentialStrategyBox } from '@/components/ConfidentialStrategyBox';
import { AprGauge } from '@/components/AprGauge';
import { PnlChart } from '@/components/PnlChart';
import { TransactionHistory } from '@/components/TransactionHistory';
import { WithdrawModule } from '@/components/WithdrawModule';
import { PortfolioTicker } from '@/components/PortfolioTicker';
import {
  ShieldCheck,
  Layers,
  TrendingUp,
  LogOut,
  ChevronRight,
  Activity,
  Cpu,
  ArrowRight,
  LayoutDashboard,
  Settings,
  History
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

const SECTIONS = [
  { id: 'command-center', label: 'Allocation', icon: <LayoutDashboard size={14} /> },
  { id: 'live-alpha', label: 'Activity', icon: <History size={14} /> },
  { id: 'exit-flow', label: 'Withdraw', icon: <LogOut size={14} /> },
];

function SectionHeading({ id, label, sublabel }: { id: string; label: string; sublabel: string }) {
  return (
    <div id={id} className="mb-12 pt-24 group">
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-3xl font-heading font-bold tracking-tighter text-[#F5F7FA]">
          {label}
        </h2>
        <div className="h-px flex-1 bg-white/[0.05]" />
      </div>
      <p className="text-xs font-mono font-bold text-[#484F58] uppercase tracking-[0.4em]">
        {sublabel}
      </p>
    </div>
  );
}

export default function CommandCenter() {
  const { address } = useAccount();
  const [workerState, setWorkerState] = useState<WorkerState | null>(null);
  const [consensus, setConsensus] = useState<ConsensusData | null>(null);
  const [mounted, setMounted] = useState(false);

  const fetchState = async () => {
    if (!address) {
      setWorkerState(null);
      return;
    }
    try {
      const res = await fetch(`/api/state?userAddress=${address}`);
      if (res.ok) {
        const data = await res.json();
        setWorkerState(data);
      }
    } catch { }
  };

  const fetchConsensus = async () => {
    try {
      const res = await fetch('/api/consensus');
      if (res.ok) {
        const data = await res.json();
        setConsensus(data);
      }
    } catch { }
  };

  useEffect(() => {
    setMounted(true);
    if (address) {
      fetchState();
    }
    fetchConsensus();
    const stateInterval = setInterval(() => {
      if (address) fetchState();
    }, 10000);
    const consensusInterval = setInterval(fetchConsensus, 30000);
    return () => {
      clearInterval(stateInterval);
      clearInterval(consensusInterval);
    };
  }, [address]);

  const { data: blockNumber } = useBlockNumber({ watch: true });
  const queryClient = useQueryClient();

  const { data: maxWithdraw, refetch: refetchUserData } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  useEffect(() => {
    if (blockNumber) {
      refetchUserData();
    }
  }, [blockNumber, refetchUserData]);

  const balance = maxWithdraw ? parseFloat(formatUnits(maxWithdraw as bigint, 6)) : 0;
  
  const isHealthy = workerState?.apiFailureStreak === 0 && !workerState?.defaultState;
  const isWarning = (workerState?.apiFailureStreak ?? 0) > 0 && (workerState?.apiFailureStreak ?? 0) < 3;

  const prevApr =
    consensus?.consensus ??
    (workerState?.previousApr != null ? Math.round(workerState.previousApr * 10_000) : null);
  const ewmMean = workerState?.rewardAprEwm?.mean ?? null;

  if (!mounted) return null;

  return (
    <div className="min-h-screen">
      <Header isHealthy={!!isHealthy} isWarning={!!isWarning} />

      <main className="max-w-7xl mx-auto px-6 pb-40">

        {/* Hero Portfolio Section (Jupiter Style) */}
        <div className="pt-12 mb-16">
          <PortfolioTicker
            balance={balance}
            unrealizedYield={workerState?.unrealizedYieldUsd ?? 0}
            totalRealized={workerState?.totalRealizedProfitUsd ?? 0}
            apr={workerState?.previousApr ?? 0}
          />
        </div>

        {/* Status Dashboard Bar */}
        <div className="mb-20 animate-fade-in">
          <div className={`
            ys-card p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-[#0B0F0D]/60
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
            
            <div className="flex flex-wrap items-center gap-10">
              <div className="flex items-center gap-3">
                <Activity size={16} className="text-[#C2E812]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Trades: <span className="text-[#F5F7FA]">{workerState?.gridTradesExecuted ?? 0}</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Cpu size={16} className="text-[#00FFA3]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Checkpoint: <span className="text-[#F5F7FA]">{workerState?.yieldIndexerCheckpointBlock ?? '0'}</span>
                </span>
              </div>
              {workerState?.lastDecisionReason && (
                <div className="px-4 py-1.5 rounded-xl bg-white/5 border border-white/10 text-[10px] font-mono text-[#8B949E] font-bold tracking-widest uppercase">
                  {workerState.lastDecisionReason}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── SECTION 1: ALLOCATION ─── */}
        <SectionHeading
          id="command-center"
          label="Vault Allocation"
          sublabel="Principal control & parameterization"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 mb-24 animate-fade-in">
          <DepositModule />
          <ConfidentialStrategyBox />
        </div>

        {/* ─── SECTION 2: PERFORMANCE ─── */}
        <SectionHeading
          id="live-alpha"
          label="Activity & Audit"
          sublabel="Real-time verified yield engine"
        />
        <div className="animate-fade-in space-y-10" style={{ animationDelay: '0.1s' }}>
          <PnlChart
            currentBalance={balance}
            initialDeposit={balance} // Using current balance as base for demo
            totalRealized={workerState?.totalRealizedProfitUsd ?? 0}
            unrealizedYield={workerState?.unrealizedYieldUsd ?? 0}
          />
          <TransactionHistory />
        </div>

        {/* ─── SECTION 3: WITHDRAW ─── */}
        <SectionHeading
          id="exit-flow"
          label="Liquidity Exit"
          sublabel="Vault withdrawal & settlement"
        />
        <div className="max-w-3xl mx-auto animate-fade-in" style={{ animationDelay: '0.2s' }}>
          <WithdrawModule />
        </div>

        {/* Artistic Footer (Jupiter Style) */}
        <footer className="mt-60 pt-20 border-t border-white/[0.05]">
          <div className="flex flex-col md:flex-row items-center justify-between gap-16">
            <div className="flex flex-col gap-8">
              <div className="flex items-center gap-5">
                <div className="w-12 h-12 rounded-2xl bg-[#C2E812] flex items-center justify-center shadow-lg shadow-[#C2E812]/20">
                  <ShieldCheck size={24} className="text-[#030605]" />
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
                href={`https://base-sepolia.blockscout.com/address/${KEEPER_ADDRESS}`}
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
