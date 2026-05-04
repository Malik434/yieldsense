'use client';

import { useEffect, useState, useMemo } from 'react';
import { TrendingUp, Wallet, ArrowUpRight, BarChart3, Target } from 'lucide-react';

interface PortfolioTickerProps {
  balance: number;
  unrealizedYield: number;
  totalRealized: number;
  apr: number;
}

export function PortfolioTicker({ balance, unrealizedYield, totalRealized, apr }: PortfolioTickerProps) {
  const [tickerBalance, setTickerBalance] = useState(balance + unrealizedYield);

  // Velocity calculation: how much yield is generated per ms
  // Assuming 20% APR = 0.20 / (365 * 24 * 60 * 60 * 1000) per ms
  const msInYear = 365 * 24 * 60 * 60 * 1000;
  const yieldPerMs = useMemo(() => {
    return (balance * (apr / 100)) / msInYear;
  }, [balance, apr]);

  useEffect(() => {
    setTickerBalance(balance + unrealizedYield);
    
    const interval = setInterval(() => {
      setTickerBalance(prev => prev + yieldPerMs * 100); // update every 100ms
    }, 100);

    return () => clearInterval(interval);
  }, [balance, unrealizedYield, yieldPerMs]);

  const netWorth = tickerBalance;
  const dailyChange = (netWorth * (apr / 100 / 365));
  const dailyChangePct = (apr / 365).toFixed(2);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
      {/* Primary Net Worth Card (Jupiter Style) */}
      <div className="ys-card p-10 flex flex-col justify-between min-h-[280px] bg-gradient-to-br from-[#0B0F0D] to-[#030605]">
        <div className="space-y-1">
          <p className="text-[11px] font-mono font-bold text-[#8B949E] uppercase tracking-[0.3em]">Net Value</p>
          <div className="flex items-baseline gap-4 mt-2">
            <h2 className="text-6xl font-heading font-bold text-[#F5F7FA] tracking-tighter">
              ${netWorth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h2>
            <span className="text-xl font-heading font-medium text-[#484F58] tracking-tight">
              {(netWorth / 1.0).toFixed(2)} USDC
            </span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm font-heading font-bold text-[#FF4466]">
              -${(dailyChange * 0.1).toFixed(2)} (-0.12%)
            </span>
            <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Since Yesterday</span>
          </div>
        </div>

        <div className="flex items-center gap-8 pt-8 border-t border-white/[0.03]">
          <div className="space-y-1">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-2">
              <Target size={12} className="text-[#C2E812]" />
              Allocated
            </p>
            <p className="text-xl font-heading font-bold text-[#F5F7FA]">
              ${balance.toLocaleString()}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-2">
              <ArrowUpRight size={12} className="text-[#00FFA3]" />
              Unrealized
            </p>
            <p className="text-xl font-heading font-bold text-[#00FFA3]">
              +${unrealizedYield.toLocaleString(undefined, { minimumFractionDigits: 4 })}
            </p>
          </div>
        </div>
      </div>

      {/* Yield Performance Card */}
      <div className="ys-card p-10 flex flex-col justify-between min-h-[280px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 px-0 py-2 text-[#C2E812]">
            <BarChart3 size={16} />
            <span className="text-[11px] font-mono font-bold uppercase tracking-[0.3em]">Yield Estimate</span>
          </div>
          <div className="flex gap-2">
            {['24H', '1M', '1Y'].map(t => (
              <button key={t} className={`px-4 py-1.5 rounded-full text-[10px] font-mono font-bold tracking-widest transition-all ${t === '1Y' ? 'bg-[#C2E812] text-[#030605]' : 'bg-white/5 text-[#484F58] hover:text-[#8B949E]'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 space-y-2">
          <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Projected Yearly Yield</p>
          <div className="flex items-baseline gap-3">
            <h3 className="text-5xl font-heading font-bold text-[#F5F7FA]">
              ${(balance * (apr / 100)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h3>
            <span className="text-xl font-heading font-bold text-[#C2E812]">
              +{apr.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 pt-8">
          <div className="flex -space-x-3">
            <div className="w-8 h-8 rounded-full bg-[#0052FF] border-2 border-[#0B0F0D] flex items-center justify-center text-[10px] font-bold">B</div>
            <div className="w-8 h-8 rounded-full bg-[#00FFA3] border-2 border-[#0B0F0D] flex items-center justify-center text-[10px] font-bold">A</div>
            <div className="w-8 h-8 rounded-full bg-[#C2E812] border-2 border-[#0B0F0D] flex items-center justify-center text-[10px] font-bold">Y</div>
          </div>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">
            Yielding across 12 platforms
          </span>
        </div>
      </div>
    </div>
  );
}
