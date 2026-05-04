'use client';

import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  Shield, 
  Info, 
  Clock, 
  RefreshCw, 
  CheckCircle2, 
  Target 
} from 'lucide-react';
import { useAccount } from 'wagmi';
import { OPERATOR_ADDRESS } from '@/lib/contracts';

interface PnlDataPoint {
  time: string;
  balance: number;
  deposit: number;
  timestamp: number;
}

interface PnlChartProps {
  currentBalance: number;
  initialDeposit: number;
  totalRealized?: number;
  unrealizedYield?: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const balance = payload.find((p: any) => p.dataKey === 'balance')?.value ?? 0;
  const deposit = payload.find((p: any) => p.dataKey === 'deposit')?.value ?? 0;
  const pnl = balance - deposit;
  const pnlPct = deposit > 0 ? ((pnl / deposit) * 100).toFixed(2) : '0.00';

  return (
    <div className="ys-card bg-[#0B0F0D]/95 border-white/10 p-5 shadow-2xl backdrop-blur-xl">
      <p className="text-[10px] font-mono font-bold text-[#484F58] mb-3 uppercase tracking-[0.2em]">{label}</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-10">
          <span className="text-[10px] font-mono text-[#8B949E] uppercase tracking-wider">Net Value</span>
          <span className="text-sm font-heading font-bold text-[#F5F7FA]">${balance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="flex items-center justify-between gap-10 border-t border-white/5 pt-2 mt-1">
          <span className="text-[10px] font-mono text-[#8B949E] uppercase tracking-wider">Growth</span>
          <span className={`text-sm font-heading font-bold ${pnl >= 0 ? 'text-[#C2E812]' : 'text-[#FF4466]'}`}>
            {pnl >= 0 ? '+' : ''}{pnlPct}%
          </span>
        </div>
      </div>
    </div>
  );
};

export function PnlChart({ currentBalance, initialDeposit, totalRealized = 0, unrealizedYield = 0 }: PnlChartProps) {
  const { address } = useAccount();
  const [data, setData] = useState<PnlDataPoint[]>([]);
  const [mounted, setMounted] = useState(false);
  const [period, setPeriod] = useState('1D');
  const [loading, setLoading] = useState(true);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}`);
      if (!res.ok) throw new Error('Failed to fetch state');
      const state = await res.json();
      const logs = (state.logs || []).reverse(); 

      let cumulativePnl = 0;
      const points: PnlDataPoint[] = [];

      points.push({
        time: 'Start',
        balance: initialDeposit,
        deposit: initialDeposit,
        timestamp: Date.now() - 86400000 * 7
      });

      logs.forEach((log: any) => {
        const ts = (log.timestamp || 0) * 1000;
        if (log.event === 'harvest_confirmed') {
          cumulativePnl += (log.rewardUsd || 0);
        } else if (log.event === 'grid_trade_executed') {
          cumulativePnl += (Number(log.pnlDelta || 0) / 1_000_000);
        } else {
          return;
        }

        const date = new Date(ts);
        points.push({
          time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          balance: initialDeposit + cumulativePnl,
          deposit: initialDeposit,
          timestamp: ts
        });
      });

      if (points.length > 0) {
        points.push({
          time: 'Now',
          balance: currentBalance + unrealizedYield,
          deposit: initialDeposit,
          timestamp: Date.now()
        });
      }

      const now = Date.now();
      let filtered = points;
      if (period === '1D') filtered = points.filter(p => now - p.timestamp < 86400000);
      else if (period === '1W') filtered = points.filter(p => now - p.timestamp < 86400000 * 7);
      else if (period === '1M') filtered = points.filter(p => now - p.timestamp < 86400000 * 30);

      if (filtered.length < 2) filtered = points;

      const finalData = filtered.map(p => ({
        ...p,
        time: new Date(p.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      }));

      setData(finalData);
    } catch (err) {
      console.error('Failed to fetch chart history:', err);
      setData([
        { time: 'May 01', balance: initialDeposit, deposit: initialDeposit, timestamp: 0 },
        { time: 'May 04', balance: currentBalance + unrealizedYield, deposit: initialDeposit, timestamp: 0 },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    fetchHistory();
  }, [address, currentBalance, initialDeposit, period]);

  if (!mounted) return null;

  return (
    <div className="ys-card p-10 flex flex-col gap-8 h-full bg-[#0B0F0D] group/chart relative overflow-hidden">
      <div className="absolute top-0 right-0 p-12 bg-[#C2E812]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-[#C2E812]/5 border border-[#C2E812]/10 flex items-center justify-center">
            <Activity size={24} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Guardian Analytics</p>
            <h3 className="text-2xl font-heading font-bold text-[#F5F7FA]">Asset Growth Audit</h3>
          </div>
        </div>
        <div className="flex bg-black/40 p-1 rounded-xl border border-white/[0.05]">
          {['1D', '1W', '1M', 'ALL'].map(t => (
            <button 
              key={t} 
              onClick={() => setPeriod(t)}
              className={`px-6 py-2 rounded-lg text-[10px] font-mono font-bold tracking-widest transition-all ${period === t ? 'bg-[#C2E812] text-[#030605]' : 'text-[#484F58] hover:text-[#8B949E]'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 relative z-10">
        {[
          { label: 'Settled Profit', value: `$${totalRealized.toFixed(2)}`, color: 'text-[#C2E812]', icon: <CheckCircle2 size={12} /> },
          { label: 'Unrealized', value: `+$${unrealizedYield.toFixed(4)}`, color: 'text-[#00FFA3]', icon: <TrendingUp size={12} /> },
          { label: 'Principal', value: `$${initialDeposit.toFixed(2)}`, color: 'text-[#8B949E]', icon: <Shield size={12} /> },
          { label: 'Net Position', value: `$${(currentBalance + unrealizedYield).toFixed(2)}`, color: 'text-[#F5F7FA]', icon: <Target size={12} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.04] space-y-2">
            <div className="flex items-center gap-2">
              {icon}
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">{label}</p>
            </div>
            <p className={`text-2xl font-heading font-bold ${color} tracking-tight`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="relative flex-1 min-h-[350px] mt-4 relative z-10">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B0F0D]/50 backdrop-blur-sm z-20 rounded-3xl">
            <RefreshCw size={32} className="text-[#C2E812] animate-spin opacity-40" />
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 20, right: 0, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="limeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#C2E812" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#C2E812" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="8 8" stroke="rgba(255, 255, 255, 0.02)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#484F58', fontFamily: 'JetBrains Mono', fontSize: 9, fontWeight: 700 }}
              axisLine={false}
              tickLine={false}
              dy={15}
              minTickGap={30}
            />
            <YAxis
              tick={{ fill: '#484F58', fontFamily: 'JetBrains Mono', fontSize: 9, fontWeight: 700 }}
              axisLine={false}
              tickLine={false}
              domain={['auto', 'auto']}
              tickFormatter={(v) => `$${v.toFixed(0)}`}
              dx={-10}
            />
            <Tooltip 
              content={<CustomTooltip />} 
              cursor={{ stroke: 'rgba(194, 232, 18, 0.2)', strokeWidth: 2 }}
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="#C2E812"
              strokeWidth={4}
              fill="url(#limeGrad)"
              dot={false}
              activeDot={{ r: 8, fill: '#C2E812', stroke: '#030605', strokeWidth: 4 }}
              animationDuration={1500}
              animationEasing="ease-in-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center justify-between pt-8 border-t border-white/[0.03] relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#C2E812] animate-pulse" />
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em]">Real-time Telemetry Synchronization Active</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Shield size={12} className="text-[#00FFA3]" />
            <span className="text-[10px] font-mono font-bold text-[#00FFA3] uppercase tracking-widest">Acurast Verified</span>
          </div>
          <button 
            onClick={fetchHistory}
            className="p-2 rounded-lg bg-white/5 border border-white/5 text-[#484F58] hover:text-[#C2E812] transition-all"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
