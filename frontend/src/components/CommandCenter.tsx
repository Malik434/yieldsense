"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useAccount, useReadContract, useBlockNumber } from "wagmi";
import { formatUnits } from "viem";
import { useNetwork } from "@/providers/NetworkProvider";

import { KEEPER_ABI, OPERATOR_ADDRESS } from "@/lib/contracts";
import { Header } from "@/components/Header";
import { DepositModule } from "@/components/DepositModule";
import { GridTradingDashboard } from "@/components/GridTradingDashboard";
import { PnlChart } from "@/components/PnlChart";
import { TransactionHistory } from "@/components/TransactionHistory";
import { WithdrawModule } from "@/components/WithdrawModule";
import { PortfolioTicker } from "@/components/PortfolioTicker";
import { TestingSuite } from "@/components/TestingSuite";
import { YieldOrchestrationControl } from "@/components/YieldOrchestrationControl";
import { Activity, Cpu, ArrowRight } from "lucide-react";

const TOKEN_ICONS = {
  aero: "https://aerodrome.finance/svg/AERO/favicon.svg",
  usdc: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
  usdt: "https://tether.to/images/logoCircle.svg",
  eth: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  acu: "https://hub.acurast.com/assets/acurast-logo.png",
} as const;

interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number;
  yieldIndexerCheckpointBlock: number | null;
  rewardAprEwm: {
    mean: number;
    variance: number;
    lastTimestamp: number;
  } | null;
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

function SectionHeading({
  id,
  label,
  sublabel,
  align = "left",
}: {
  id: string;
  label: string;
  sublabel: string;
  align?: "left" | "center";
}) {
  return (
    <div
      id={id}
      className={`mb-6 pt-12 group sm:mb-8 sm:pt-16 ${
        align === "center" ? "mx-auto max-w-3xl text-center" : ""
      }`}
    >
      <div className="mb-4 flex min-w-0 items-center gap-3 sm:gap-4">
        {align === "center" && <div className="h-px flex-1 bg-white/[0.05]" />}
        <h2 className="min-w-0 break-words text-2xl font-heading font-bold tracking-tight text-[#F5F7FA] sm:text-3xl sm:tracking-tighter">
          {label}
        </h2>
        <div className="h-px flex-1 bg-white/[0.05]" />
      </div>
      <p className="break-words text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-[#484F58] sm:text-xs sm:tracking-[0.4em]">
        {sublabel}
      </p>
    </div>
  );
}

function UsdcMark() {
  return (
    <div className="relative h-12 w-16 shrink-0">
      <div className="absolute left-0 top-1 grid h-8 w-8 place-items-center overflow-hidden rounded-full border border-white/20 bg-white shadow-lg shadow-[#2775CA]/20">
        <img src={TOKEN_ICONS.usdc} alt="USDC" className="h-full w-full object-cover" loading="lazy" />
      </div>
      <div className="absolute right-1 top-3 grid h-8 w-8 place-items-center overflow-hidden rounded-full border border-[#26A17B]/30 bg-white shadow-lg shadow-[#26A17B]/20">
        <img src={TOKEN_ICONS.usdt} alt="USDT" className="h-full w-full object-cover" loading="lazy" />
      </div>
    </div>
  );
}

function GridTokenMark() {
  return (
    <div className="relative h-12 w-16 shrink-0">
      <div className="absolute left-0 top-0 grid h-7 w-7 place-items-center overflow-hidden rounded-full border border-[#C2E812]/30 bg-black shadow-lg shadow-[#C2E812]/10">
        <img src={TOKEN_ICONS.acu} alt="ACU" className="h-full w-full object-cover" loading="lazy" />
      </div>
      <div className="absolute right-0 top-1 grid h-7 w-7 place-items-center overflow-hidden rounded-full border border-[#627EEA]/40 bg-white shadow-lg shadow-[#627EEA]/10">
        <img src={TOKEN_ICONS.eth} alt="ETH" className="h-full w-full object-cover" loading="lazy" />
      </div>
      <div className="absolute bottom-0 left-1/2 grid h-7 w-7 -translate-x-1/2 place-items-center overflow-hidden rounded-full border border-[#00FFA3]/30 bg-black shadow-lg shadow-[#00FFA3]/10">
        <img src={TOKEN_ICONS.aero} alt="AERO" className="h-full w-full object-cover" loading="lazy" />
      </div>
    </div>
  );
}

function StartHerePanel() {
  const actions = [
    {
      title: "Earn yield",
      description: "Deposit USDC into the yield vault and let the keeper manage the pool position.",
      href: "#command-center",
      cta: "Deposit USDC",
      icon: <UsdcMark />,
    },
    {
      title: "Run a grid",
      description: "Deposit grid capital, choose a pair, set price limits, then enable automation.",
      href: "#grid-trading",
      cta: "Create strategy",
      icon: <GridTokenMark />,
    },
  ];

  return (
    <section className="pt-6 sm:pt-10">
      <div className="ys-card bg-[#0B0F0D]/70 p-5 sm:p-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-heading font-bold tracking-tight text-[#F5F7FA] sm:text-4xl">
              Start with one action.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-[#8B949E]">
              Choose yield for passive vault exposure, or grid trading for an automated pair strategy. Advanced analytics stay available after setup.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {actions.map(({ title, description, href, cta, icon }) => (
              <a
                key={title}
                href={href}
                className="group rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition-all hover:border-[#C2E812]/25 hover:bg-[#C2E812]/[0.04] sm:p-5"
              >
                <div className="flex items-start gap-3">
                  {icon}
                  <div className="min-w-0">
                    <h2 className="break-words text-lg font-heading font-bold text-[#F5F7FA]">{title}</h2>
                    <p className="mt-1 text-xs leading-relaxed text-[#8B949E]">{description}</p>
                  </div>
                </div>
                <div className="mt-4 inline-flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#C2E812]">
                  {cta}
                  <ArrowRight size={13} className="transition-transform group-hover:translate-x-1" />
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
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
      const res = await fetch(
        `/api/state?userAddress=${OPERATOR_ADDRESS}&chainId=${chainId}`,
      );
      if (res.ok) {
        const data = await res.json();
        setVaultState(data);
      }
    } catch {}
  }, [chainId]);

  const fetchConsensus = useCallback(async () => {
    try {
      const res = await fetch(`/api/consensus?chainId=${chainId}`);
      if (res.ok) {
        const data = await res.json();
        setConsensus(data);
      }
    } catch {}
  }, [chainId]);

  const fetchOnchainAudit = useCallback(async () => {
    if (!address) {
      setOnchainAudit(null);
      return;
    }

    try {
      const res = await fetch(
        `/api/onchain-audit?userAddress=${address}&chainId=${chainId}`,
      );
      if (res.ok) {
        const data = await res.json();
        setOnchainAudit(data);
      }
    } catch {}
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
    functionName: "maxWithdraw",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!KEEPER_ADDRESS },
  });

  const { data: userSharesRaw, refetch: refetchUserShares } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!KEEPER_ADDRESS },
  });

  const { data: totalSharesRaw } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: "totalSupply",
    query: { enabled: !!KEEPER_ADDRESS },
  });

  const { data: totalAssetsRaw } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: "totalAssets",
    query: { enabled: !!KEEPER_ADDRESS },
  });

  useEffect(() => {
    if (blockNumber) {
      refetchUserData();
      refetchUserShares();
    }
  }, [blockNumber, refetchUserData, refetchUserShares]);

  const withdrawableBalance = maxWithdraw
    ? parseFloat(formatUnits(maxWithdraw as bigint, 6))
    : 0;
  const totalShares = totalSharesRaw
    ? parseFloat(formatUnits(totalSharesRaw as bigint, 6))
    : 0;
  const globalTvl = totalAssetsRaw
    ? parseFloat(formatUnits(totalAssetsRaw as bigint, 6))
    : 0;
  const userShares = userSharesRaw
    ? parseFloat(formatUnits(userSharesRaw as bigint, 6))
    : 0;

  const vaultShareFraction: number =
    totalShares > 0 && userShares > 0
      ? Math.min(userShares / totalShares, 1)
      : withdrawableBalance > 0
        ? 1
        : 0;

  const vaultUnrealized = vaultState?.unrealizedYieldUsd ?? 0;
  const userProfit = onchainAudit?.userProfitCreditedUsd ?? 0;
  const userVaultValue = globalTvl * vaultShareFraction;
  const userPrincipal = onchainAudit?.principalUsd ?? userVaultValue;
  const userUnrealized = vaultUnrealized * vaultShareFraction;

  const isHealthy =
    vaultState?.apiFailureStreak === 0 && !vaultState?.defaultState;
  const isWarning =
    (vaultState?.apiFailureStreak ?? 0) > 0 &&
    (vaultState?.apiFailureStreak ?? 0) < 3;

  const prevApr =
    consensus?.consensus ??
    (vaultState?.previousApr != null
      ? Math.round(vaultState.previousApr * 10_000)
      : null);

  return (
    <div className="min-h-screen">
      <Header isHealthy={!!isHealthy} isWarning={!!isWarning} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-28 sm:pb-40">
        <StartHerePanel />

        <div className="pt-8 sm:pt-12 mb-10 sm:mb-16">
          <PortfolioTicker
            balance={userVaultValue}
            unrealizedYield={userUnrealized}
            totalRealized={userProfit}
            apr={prevApr != null ? prevApr / 100 : 0}
            globalTvl={globalTvl}
          />
        </div>

        <div className="mb-14 sm:mb-20 animate-fade-in">
          <div
            className={`
            ys-card p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-[#0B0F0D]/60
            ${isHealthy ? "border-[#C2E812]/10" : isWarning ? "border-amber-500/10" : "border-[#FF4466]/10"}
          `}
          >
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              <div className="relative">
                <div
                  className={`status-dot ${isHealthy ? "bg-[#C2E812]" : isWarning ? "bg-amber-400" : "bg-[#FF4466]"}`}
                />
              </div>
              <span className="min-w-0 break-words text-sm font-heading font-bold uppercase tracking-tight text-[#F5F7FA]">
                {isHealthy
                  ? "System Ready"
                  : isWarning
                    ? "Data Sync Warning"
                    : "Processor Offline"}
              </span>
            </div>

            <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5 lg:gap-10">
              <div className="flex items-center gap-3">
                <Activity size={16} className="text-[#C2E812]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Trades:{" "}
                  <span className="text-[#F5F7FA]">
                    {vaultState?.gridTradesExecuted ?? 0}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Cpu size={16} className="text-[#00FFA3]" />
                <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
                  Checkpoint:{" "}
                  <span className="text-[#F5F7FA]">
                    {vaultState?.yieldIndexerCheckpointBlock ?? "0"}
                  </span>
                </span>
              </div>
              {vaultState?.lastDecisionReason && (
                <div className="max-w-full break-words rounded-xl border border-white/10 bg-white/5 px-4 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E]">
                  {vaultState.lastDecisionReason}
                </div>
              )}
            </div>
          </div>
          <div className="mt-5">
            <YieldOrchestrationControl />
          </div>
        </div>

        <SectionHeading
          id="command-center"
          label="Vault Allocation"
          sublabel="Deposit USDC into the yield vault"
          align="center"
        />
        <div className="mx-auto max-w-xl mb-12 sm:mb-16 animate-fade-in">
          <DepositModule />
        </div>

        <SectionHeading
          id="grid-trading"
          label="Grid Trading"
          sublabel="Create a pair strategy and enable automation"
        />
        <div className="mb-16 sm:mb-24 animate-fade-in">
          <GridTradingDashboard />
        </div>

        <details className="mb-16 sm:mb-24">
          <summary className="mx-auto flex max-w-xl cursor-pointer list-none items-center justify-center gap-3 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-center text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E] transition-colors hover:text-[#F5F7FA]">
            View activity, charts, and audit tools
            <ArrowRight size={13} />
          </summary>
          <SectionHeading
            id="live-alpha"
            label="Activity & Audit"
            sublabel="Performance, history, and testing tools"
          />
          <div
            className="animate-fade-in space-y-10"
            style={{ animationDelay: "0.1s" }}
          >
            <PnlChart
              currentBalance={userVaultValue}
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
        </details>

        <SectionHeading
          id="exit-flow"
          label="Liquidity Exit"
          sublabel="Withdraw available vault funds"
        />
        <div
          className="mx-auto max-w-xl animate-fade-in"
          style={{ animationDelay: "0.2s" }}
        >
          <WithdrawModule />
        </div>

        <footer className="mt-32 border-t border-white/[0.05] pt-16 sm:mt-60 sm:pt-20">
          <div className="flex flex-col items-center justify-between gap-12 md:flex-row md:gap-16">
            <div className="flex min-w-0 flex-col gap-8 text-center md:text-left">
              <div className="flex min-w-0 flex-col items-center gap-4 sm:flex-row sm:gap-5 md:items-center">
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
                  <span className="font-heading text-2xl font-bold text-[#F5F7FA] sm:text-3xl">
                    YieldSense
                  </span>
                  <p className="mt-1 text-[10px] font-mono font-bold uppercase tracking-[0.25em] text-[#C2E812] sm:tracking-[0.5em]">
                    Autonomous Systems
                  </p>
                </div>
              </div>
              <p className="max-w-sm break-words text-[11px] font-mono uppercase leading-relaxed tracking-[0.14em] text-[#484F58] sm:text-xs sm:tracking-[0.2em]">
                Yield vault deposits and grid strategies for capped mainnet testing.
              </p>
            </div>

            <div className="flex max-w-full flex-col items-center gap-6 md:items-end md:gap-8">
              <a
                href={`${config.explorer}/address/${KEEPER_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-3 text-center text-[10px] font-mono font-bold uppercase tracking-[0.22em] text-[#8B949E] transition-all duration-500 hover:text-[#C2E812] sm:text-[11px] sm:tracking-[0.4em]"
              >
                Explorer Verified
                <ArrowRight
                  size={16}
                  className="group-hover:translate-x-3 transition-transform duration-500"
                />
              </a>
              <div className="max-w-full break-all rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-center text-[10px] font-mono font-bold tracking-widest text-[#484F58] sm:px-6 sm:text-xs">
                {KEEPER_ADDRESS}
              </div>
            </div>
          </div>

          <div className="mt-16 text-center sm:mt-24">
            <span className="break-words text-[10px] font-mono font-bold uppercase tracking-[0.25em] text-[#484F58] opacity-40 sm:tracking-[0.6em]">
              © 2026 YieldSense Autonomous Guardian
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
