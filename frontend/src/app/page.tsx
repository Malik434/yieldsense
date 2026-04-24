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
import { TestingSuite } from '@/components/TestingSuite';
import {
  ShieldCheck,
  Layers,
  TrendingUp,
  LogOut,
  AlertCircle,
  ChevronRight,
  Droplets
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
  { id: 'testing-suite', label: 'TESTNET', icon: <Droplets size={12} /> },
  { id: 'command-center', label: 'STRATEGY', icon: <Layers size={12} /> },
  { id: 'live-alpha', label: 'LIVE ALPHA', icon: <TrendingUp size={12} /> },
  { id: 'exit-flow', label: 'EXIT', icon: <LogOut size={12} /> },
];

function SectionHeading({ id, label, sublabel }: { id: string; label: string; sublabel: string }) {
  return (
    <div id={id} className="section-divider">
      <span
        className="font-mono font-bold tracking-widest px-4 py-1.5 rounded-lg"
        style={{
          fontSize: 11,
          color: '#00ff9f',
          letterSpacing: '0.2em',
          background: 'rgba(0,255,159,0.04)',
          border: '1px solid rgba(0,255,159,0.12)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span className="font-mono text-xs" style={{ color: '#334155', whiteSpace: 'nowrap' }}>
        {sublabel}
      </span>
    </div>
  );
}

export default function CommandCenter() {
  const { address } = useAccount();
  const [workerState, setWorkerState] = useState<WorkerState | null>(null);
  const [consensus, setConsensus] = useState<ConsensusData | null>(null);
  const [mounted, setMounted] = useState(false);

  // Fetch worker state from Acurast processor
  const fetchState = async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data = await res.json();
        setWorkerState(data);
      }
    } catch { }
  };

  // Fetch consensus APR
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
    fetchState();
    fetchConsensus();
    const stateInterval = setInterval(fetchState, 10000);
    const consensusInterval = setInterval(fetchConsensus, 30000);
    return () => {
      clearInterval(stateInterval);
      clearInterval(consensusInterval);
    };
  }, []);

  // Watch block number to trigger refetches
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const queryClient = useQueryClient();

  // Read vault user data
  const { data: userData, refetch: refetchUserData, queryKey } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'userData',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Automatically refetch when a new block is mined (covers deposits/harvests)
  useEffect(() => {
    if (blockNumber) {
      refetchUserData();
    }
  }, [blockNumber, refetchUserData]);

  // USDC has 6 decimals. The keeper stores balances in asset-native units.
  const balance = userData ? parseFloat(formatUnits((userData as any)[0] as bigint, 6)) : 0;
  const initialDeposit = userData ? parseFloat(formatUnits((userData as any)[1] as bigint, 6)) : 0;

  const isHealthy = workerState?.apiFailureStreak === 0 && !workerState?.defaultState;
  const isWarning = (workerState?.apiFailureStreak ?? 0) > 0 && (workerState?.apiFailureStreak ?? 0) < 3;

  // consensus.consensus is in BPS (e.g. 19044 = 190.44%).
  // workerState.previousApr is a decimal fraction (e.g. 0.19 = 19%) — convert to BPS before use.
  const prevApr =
    consensus?.consensus ??
    (workerState?.previousApr != null ? Math.round(workerState.previousApr * 10_000) : null);
  const ewmMean = workerState?.rewardAprEwm?.mean ?? null;

  if (!mounted) return null;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <Header isHealthy={!!isHealthy} isWarning={!!isWarning} />

      {/* Sticky section nav */}
      <div
        className="sticky z-40 top-16 w-full flex justify-center"
        style={{ padding: '0' }}
      >
        <div
          className="flex items-center gap-1 px-2 py-1.5 mt-3 rounded-xl"
          style={{
            background: 'rgba(13,17,23,0.9)',
            border: '1px solid rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {SECTIONS.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-[10px] font-semibold tracking-widest transition-all"
              style={{ color: '#475569' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#00ff9f'; (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0,255,159,0.06)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#475569'; (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
            >
              {s.icon}
              {s.label}
              {i < SECTIONS.length - 1 && <ChevronRight size={10} style={{ color: '#1e293b', marginLeft: 4 }} />}
            </a>
          ))}
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-6 pb-24" style={{ paddingTop: '2rem' }}>

        {/* Hero status bar */}
        <div
          className="rounded-xl px-5 py-3 flex items-center justify-between mb-8"
          style={{
            background: isHealthy
              ? 'rgba(0,255,159,0.04)'
              : isWarning
                ? 'rgba(245,158,11,0.04)'
                : 'rgba(255,68,102,0.04)',
            border: `1px solid ${isHealthy ? 'rgba(0,255,159,0.15)' : isWarning ? 'rgba(245,158,11,0.15)' : 'rgba(255,68,102,0.15)'}`,
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: isHealthy ? '#00ff9f' : isWarning ? '#f59e0b' : '#ff4466',
                boxShadow: `0 0 8px ${isHealthy ? '#00ff9f' : isWarning ? '#f59e0b' : '#ff4466'}`,
                animation: 'pulse-ring 1.5s ease-out infinite',
              }}
            />
            <span className="font-mono text-xs font-semibold tracking-widest" style={{ color: '#e2e8f0' }}>
              {isHealthy ? 'PROCESSOR ACTIVE — STRATEGY RUNNING' : isWarning ? 'API RETRYING — STRATEGY PAUSED' : 'NO STATE DETECTED — CONNECT WALLET TO START'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-mono text-xs" style={{ color: '#475569' }}>
              GRID TRADES:{' '}
              <span style={{ color: '#a78bfa' }}>{workerState?.gridTradesExecuted ?? 0}</span>
            </span>
            <span className="font-mono text-xs" style={{ color: '#475569' }}>
              CHECKPOINT:{' '}
              <span style={{ color: '#64748b' }}>{workerState?.yieldIndexerCheckpointBlock ?? '—'}</span>
            </span>
            {workerState?.lastDecisionReason && (
              <span
                className="font-mono text-xs px-2 py-0.5 rounded"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#f59e0b', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {workerState.lastDecisionReason}
              </span>
            )}
          </div>
        </div>

        {/* ─── SECTION 0: TESTING SUITE (TESTNET ONLY) ─── */}
        <SectionHeading
          id="testing-suite"
          label="00 · TESTNET ONBOARDING"
          sublabel="Request mock assets and view live TEE execution logs"
        />

        <div className="mb-12">
          <TestingSuite />
        </div>

        {/* ─── SECTION 1: STRATEGY COMMAND CENTER ─── */}
        <SectionHeading
          id="command-center"
          label="01 · STRATEGY COMMAND CENTER"
          sublabel="Deposit funds and configure your confidential parameters"
        />

        <div
          className="grid gap-6"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}
        >
          <DepositModule />
          <ConfidentialStrategyBox />
        </div>

        {/* ─── SECTION 2: LIVE ALPHA DASHBOARD ─── */}
        <SectionHeading
          id="live-alpha"
          label="02 · LIVE ALPHA DASHBOARD"
          sublabel="Real-time verified yield and performance tracking"
        />

        {/* APR + PnL row */}
        <div
          className="grid gap-6 mb-6"
          style={{ gridTemplateColumns: '320px 1fr' }}
        >
          <AprGauge
            previousApr={prevApr}
            rewardAprEwm={ewmMean}
            consensusData={consensus ?? undefined}
          />
          <PnlChart
            currentBalance={balance}
            initialDeposit={initialDeposit}
          />
        </div>

        <TransactionHistory />

        {/* ─── SECTION 3: EXIT FLOW ─── */}
        <SectionHeading
          id="exit-flow"
          label="03 · EXIT FLOW"
          sublabel="Withdraw liquidity with transparent fee breakdown"
        />

        <div style={{ maxWidth: 560 }}>
          <WithdrawModule />
        </div>

        {/* Footer */}
        <footer className="mt-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={13} style={{ color: '#334155' }} />
            <span className="font-mono text-xs" style={{ color: '#334155' }}>
              YieldSense · Powered by Acurast TEE · Deployed on Base
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={`https://base-sepolia.blockscout.com/address/${KEEPER_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] transition-all"
              style={{ color: '#334155' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#00d4ff')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#334155')}
            >
              View Contract ↗
            </a>
            <span className="font-mono text-[10px]" style={{ color: '#1e293b' }}>
              Keeper: {KEEPER_ADDRESS?.slice(0, 8)}...{KEEPER_ADDRESS?.slice(-6)}
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
