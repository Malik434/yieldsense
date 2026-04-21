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
  ReferenceLine,
} from 'recharts';
import { Activity, TrendingUp, TrendingDown } from 'lucide-react';

interface PnlDataPoint {
  time: string;
  balance: number;
  deposit: number;
}

interface PnlChartProps {
  currentBalance: number;
  initialDeposit: number;
}

function generateMockHistory(currentBalance: number, initialDeposit: number): PnlDataPoint[] {
  const points: PnlDataPoint[] = [];
  const now = Date.now();
  const count = 14;

  for (let i = count; i >= 0; i--) {
    const t = now - i * 6 * 60 * 60 * 1000; // Every 6h
    const label = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
    const progress = 1 - i / count;
    const noise = (Math.random() - 0.45) * 0.008 * initialDeposit;
    const balance = i === 0
      ? currentBalance
      : initialDeposit + (currentBalance - initialDeposit) * progress + noise;
    points.push({ time: label, balance: parseFloat(balance.toFixed(4)), deposit: initialDeposit });
  }
  return points;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const balance = payload[0]?.value;
  const deposit = payload[1]?.value;
  const pnl = balance - deposit;
  const pnlPct = deposit > 0 ? ((pnl / deposit) * 100).toFixed(2) : '0.00';

  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: 'rgba(13,17,23,0.95)',
        border: '1px solid rgba(0,255,159,0.2)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      }}
    >
      <p style={{ color: '#64748b', marginBottom: 6 }}>{label}</p>
      <p style={{ color: '#00ff9f' }}>BAL: {balance?.toFixed(4)}</p>
      <p style={{ color: '#64748b' }}>DEP: {deposit?.toFixed(4)}</p>
      <p style={{ color: pnl >= 0 ? '#00ff9f' : '#ff4466', marginTop: 4, fontWeight: 700 }}>
        PnL: {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} ({pnl >= 0 ? '+' : ''}{pnlPct}%)
      </p>
    </div>
  );
};

export function PnlChart({ currentBalance, initialDeposit }: PnlChartProps) {
  const [data, setData] = useState<PnlDataPoint[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (currentBalance > 0 || initialDeposit > 0) {
      setData(generateMockHistory(currentBalance || initialDeposit, initialDeposit || 1));
    } else {
      // Demo data when no wallet connected
      setData(generateMockHistory(1.083, 1.0));
    }
  }, [currentBalance, initialDeposit]);

  const pnl = currentBalance - initialDeposit;
  const pnlPct = initialDeposit > 0 ? ((pnl / initialDeposit) * 100).toFixed(2) : '0.00';
  const isProfit = pnl >= 0;

  if (!mounted) return null;

  return (
    <div className="cyber-card p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={15} style={{ color: '#00ff9f' }} />
          <span className="neon-label">PERFORMANCE TRACKER</span>
        </div>
        <div className="flex items-center gap-2">
          {isProfit ? (
            <TrendingUp size={14} style={{ color: '#00ff9f' }} />
          ) : (
            <TrendingDown size={14} style={{ color: '#ff4466' }} />
          )}
          <span
            className="font-mono text-sm font-bold"
            style={{ color: isProfit ? '#00ff9f' : '#ff4466' }}
          >
            {isProfit ? '+' : ''}{pnlPct}%
          </span>
          <span className="font-mono text-xs" style={{ color: '#64748b' }}>
            ALL TIME
          </span>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'CURRENT BALANCE', value: currentBalance.toFixed(4), color: '#00ff9f' },
          { label: 'INITIAL DEPOSIT', value: initialDeposit.toFixed(4), color: '#64748b' },
          { label: 'TOTAL PnL', value: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`, color: isProfit ? '#00ff9f' : '#ff4466' },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="rounded-lg p-3"
            style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.04)' }}
          >
            <p className="font-mono text-[10px] tracking-widest" style={{ color: '#334155' }}>{label}</p>
            <p className="font-mono font-bold text-sm mt-1" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 0, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00ff9f" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#00ff9f" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="depositGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#64748b" stopOpacity={0.1} />
                <stop offset="100%" stopColor="#64748b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#334155', fontFamily: 'JetBrains Mono', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: '#334155', fontFamily: 'JetBrains Mono', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              domain={['auto', 'auto']}
              tickFormatter={(v) => v.toFixed(3)}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={initialDeposit || 1}
              stroke="#64748b"
              strokeDasharray="4 4"
              strokeWidth={1}
              opacity={0.5}
            />
            <Area
              type="monotone"
              dataKey="deposit"
              stroke="#334155"
              strokeWidth={1}
              fill="url(#depositGrad)"
              strokeDasharray="4 4"
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="#00ff9f"
              strokeWidth={2}
              fill="url(#balanceGrad)"
              dot={false}
              activeDot={{ r: 4, fill: '#00ff9f', stroke: '#080a0f', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className="font-mono text-[10px] text-center" style={{ color: '#334155' }}>
        Performance Fee (10%) applies only when balance exceeds initial deposit · High-Water Mark enforced
      </p>
    </div>
  );
}
