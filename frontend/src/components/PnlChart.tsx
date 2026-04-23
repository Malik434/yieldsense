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
import { useAccount, usePublicClient } from 'wagmi';
import { KEEPER_ADDRESS } from '@/lib/contracts';
import { parseAbiItem, formatUnits } from 'viem';

interface PnlDataPoint {
  time: string;
  balance: number;
  deposit: number;
}

interface PnlChartProps {
  currentBalance: number;
  initialDeposit: number;
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
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [data, setData] = useState<PnlDataPoint[]>([]);
  const [mounted, setMounted] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchHistory = async () => {
    if (!address || !publicClient) {
      // Demo data when no wallet connected
      setData([
        { time: '12:00', balance: 1.0, deposit: 1.0 },
        { time: '18:00', balance: 1.02, deposit: 1.0 },
        { time: '00:00', balance: 1.05, deposit: 1.0 },
        { time: '06:00', balance: 1.083, deposit: 1.0 },
      ]);
      return;
    }

    setIsRefreshing(true);
    try {
      // Get current block to stay within the 10,000 block scan limit
      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > BigInt(9500) ? latestBlock - BigInt(9500) : BigInt(0);

      // 1. Fetch ProfitCredited events (Harvests)
      const profitLogs = await publicClient.getLogs({
        address: KEEPER_ADDRESS,
        event: parseAbiItem('event ProfitCredited(uint256 amount)'),
        fromBlock: fromBlock,
      });

      // 2. Fetch TradeExecuted events (Grid Trades)
      const tradeLogs = await publicClient.getLogs({
        address: KEEPER_ADDRESS,
        event: parseAbiItem('event TradeExecuted(address indexed user, int256 pnlDelta, uint256 nonce, bytes32 indexed digest)'),
        args: { user: address },
        fromBlock: fromBlock,
      });

      // 3. Merge and sort by block number
      const allEvents = [
        ...profitLogs.map(l => ({ type: 'profit', block: l.blockNumber, amount: (l as any).args.amount })),
        ...tradeLogs.map(l => ({ type: 'trade', block: l.blockNumber, amount: (l as any).args.pnlDelta }))
      ].sort((a, b) => Number(a.block - b.block));

      // 4. Reconstruct history
      let runningBalance = initialDeposit;
      const history: PnlDataPoint[] = [{
        time: 'Start',
        balance: initialDeposit,
        deposit: initialDeposit
      }];

      for (const event of allEvents) {
        const delta = parseFloat(formatUnits(event.amount, 6));
        runningBalance += delta;

        history.push({
          time: `Block ${event.block}`,
          balance: parseFloat(runningBalance.toFixed(4)),
          deposit: initialDeposit
        });
      }

      // Add current point
      history.push({
        time: 'Now',
        balance: currentBalance,
        deposit: initialDeposit
      });

      setData(history);
    } catch (err) {
      console.error('Failed to fetch chart history:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    fetchHistory();

    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, [address, currentBalance, initialDeposit, publicClient]);

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
          <div className={`flex items-center gap-2 transition-opacity ${isRefreshing ? 'opacity-100' : 'opacity-0'}`}>
            <div className="w-1.5 h-1.5 rounded-full bg-[#00ff9f] animate-pulse" />
            <span className="font-mono text-[9px]" style={{ color: '#00ff9f' }}>SYNCING...</span>
          </div>
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
