'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
  Shield,
  RefreshCw,
  CheckCircle2,
  Target,
  Zap,
  ArrowUpDown
} from 'lucide-react';
import { OPERATOR_ADDRESS } from '@/lib/contracts';

interface PnlDataPoint {
  time: string;
  balance: number;
  deposit: number;
  timestamp: number;
}

interface PortfolioHistoryEvent {
  type: 'deposit' | 'withdraw';
  owner: string;
  timestamp: number;
  assetsUsd: number;
  shares: string;
  txHash?: string;
}

interface OnchainAuditTimelineEvent {
  kind: 'deposit' | 'withdraw' | 'fee_mint' | 'profit_credited';
  owner?: string;
  timestamp: number;
  assetsUsd?: number;
  shares?: string;
  amountUsd?: number;
  userAmountUsd?: number;
  txHash?: string;
}

interface OnchainAuditResponse {
  timeline?: OnchainAuditTimelineEvent[];
}

interface PnlChartProps {
  currentBalance: number;
  initialDeposit: number;
  totalRealized?: number;
  unrealizedYield?: number;
  /** Address to scope telemetry log fetch. Falls back to OPERATOR_ADDRESS. */
  userAddress?: string;
  /** Connected wallet whose on-chain deposits/withdrawals define the portfolio timeline. */
  portfolioAddress?: string;
  chainId: number;
  /**
   * The connected user's fractional share of the vault (userShares / totalShares).
   * Harvest rewards in the telemetry logs represent vault-wide income, so each
   * user's chart curve is scaled to their ownership fraction.
   * Defaults to 1 (show full vault amounts — correct for the operator / sole depositor).
   */
  vaultShareFraction?: number;
}

// How often the chart auto-refreshes in the background (ms).
// Decoupled from block production so we don't hammer the API every 2 s.
const CHART_REFRESH_INTERVAL_MS = 60_000;

const PERIOD_WINDOWS: Record<string, number> = {
  '1D': 86_400_000,
  '1W': 86_400_000 * 7,
  '1M': 86_400_000 * 30,
};

function formatChartTime(timestamp: number, period: string): string {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions =
    period === '1D'
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };

  return date.toLocaleDateString([], options);
}

async function fetchPortfolioHistory(
  portfolioAddress: string | undefined,
  chainId: number
): Promise<PortfolioHistoryEvent[]> {
  if (!portfolioAddress) return [];

  try {
    const res = await fetch(`/api/portfolio-history?userAddress=${portfolioAddress}&chainId=${chainId}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch (error) {
    console.warn('[PnlChart] Falling back without on-chain deposit history:', error);
    return [];
  }
}

async function fetchOnchainAudit(
  portfolioAddress: string | undefined,
  chainId: number
): Promise<OnchainAuditResponse | null> {
  if (!portfolioAddress) return null;

  try {
    const res = await fetch(`/api/onchain-audit?userAddress=${portfolioAddress}&chainId=${chainId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.warn('[PnlChart] Falling back without on-chain audit history:', error);
    return null;
  }
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const { balance, deposit, timestamp, time } = point;
  const pnl = balance - deposit;
  const pnlPct = deposit > 0 ? ((pnl / deposit) * 100).toFixed(2) : '0.00';
  const displayLabel =
    time === 'Start' || time === 'Now'
      ? `${time} - ${new Date(timestamp).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : new Date(timestamp).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

  return (
    <div className="ys-card bg-[#0B0F0D]/95 border-white/10 p-5 shadow-2xl backdrop-blur-xl">
      <p className="text-[10px] font-mono font-bold text-[#484F58] mb-3 uppercase tracking-[0.2em]">{displayLabel}</p>
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

export function PnlChart({
  currentBalance,
  initialDeposit,
  totalRealized = 0,
  unrealizedYield = 0,
  userAddress,
  portfolioAddress,
  chainId,
}: PnlChartProps) {
  const [data, setData] = useState<PnlDataPoint[]>([]);
  const [mounted, setMounted] = useState(false);
  const [period, setPeriod] = useState('1D');
  const [loading, setLoading] = useState(true);
  const [attribution, setAttribution] = useState({ harvest: 0, gridTrades: 0 });

  // Refs hold the latest balance/yield values so the "Now" anchor in the chart
  // always reflects the current on-chain state without triggering a full API
  // refetch on every block.
  const currentBalanceRef = useRef(currentBalance);
  const unrealizedYieldRef = useRef(unrealizedYield);
  useEffect(() => {
    currentBalanceRef.current = currentBalance;
    unrealizedYieldRef.current = unrealizedYield;
  }, [currentBalance, unrealizedYield]);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    const targetAddress = userAddress ?? OPERATOR_ADDRESS;
    try {
      const res = await fetch(`/api/state?userAddress=${targetAddress}&chainId=${chainId}`);
      if (!res.ok) throw new Error('Failed to fetch state');
      const state = await res.json();
      const [portfolioEvents, onchainAudit] = await Promise.all([
        fetchPortfolioHistory(portfolioAddress, chainId),
        fetchOnchainAudit(portfolioAddress, chainId),
      ]);

      // logs are stored newest-first; reverse to get chronological order
      const logs: any[] = (state.logs ?? [])
        .slice()
        .reverse()
        .filter((log: any) => {
          const logChainId = Number(log.chainId ?? log.CHAIN_ID ?? 0);
          return logChainId === 0 || logChainId === chainId;
        });

      let cumulativePnl = 0;
      let harvestTotal = 0;
      let gridTradeCount = 0;
      const points: PnlDataPoint[] = [];

      const now = Date.now();
      const windowMs = PERIOD_WINDOWS[period] ?? Infinity;
      const periodStart = period === 'ALL' ? 0 : now - windowMs;
      const auditTimeline = Array.isArray(onchainAudit?.timeline) ? onchainAudit.timeline : [];
      const firstPortfolioEvent = portfolioEvents.find(
        (event) => event.owner?.toLowerCase() === portfolioAddress?.toLowerCase()
      );
      const firstAuditEvent = auditTimeline.find(
        (event) => event.kind === 'deposit' && event.owner?.toLowerCase() === portfolioAddress?.toLowerCase()
      );
      const firstPortfolioTs = firstPortfolioEvent ? firstPortfolioEvent.timestamp * 1000 : null;
      const firstAuditTs = firstAuditEvent ? firstAuditEvent.timestamp * 1000 : null;
      let principalBalance = 0;
      let userShares = 0;
      let totalShares = 0;
      const hasPortfolioHistory = auditTimeline.length > 0 || portfolioEvents.length > 0;
      if (!hasPortfolioHistory && initialDeposit > 0) {
        // If the RPC history endpoint is unavailable but the vault says the user
        // already has a balance, carry that position into the selected window.
        principalBalance = initialDeposit;
        userShares = initialDeposit;
        totalShares = initialDeposit;
      }
      const historyEvents = [
        ...(auditTimeline.length > 0 ? auditTimeline : portfolioEvents).map((event: any) => ({
          kind: event.kind ?? event.type,
          timestamp: event.timestamp * (event.timestamp > 10_000_000_000 ? 1 : 1000),
          amountUsd: event.assetsUsd ?? event.amountUsd ?? 0,
          userAmountUsd: event.userAmountUsd,
          owner: event.owner,
          shares: Number(event.shares ?? 0) / 1e6,
          txHash: event.txHash,
        })),
        ...logs.map((log) => ({
          kind: log.event,
          timestamp: Number(log.timestamp || 0) * 1000,
          amountUsd: Number(log.rewardUsd ?? 0),
          userAmountUsd: undefined,
          owner: '',
          shares: 0,
          txHash: log.txHash,
        })),
      ]
        .filter((event) => event.timestamp > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const event of historyEvents) {
        const isUserEvent = event.owner?.toLowerCase() === portfolioAddress?.toLowerCase();
        if (event.timestamp >= periodStart) break;
        if (event.kind === 'deposit') {
          totalShares += event.shares;
          if (isUserEvent) {
            userShares += event.shares;
            principalBalance += event.amountUsd;
          }
        }
        if (event.kind === 'withdraw') {
          totalShares = Math.max(0, totalShares - event.shares);
          if (isUserEvent) {
            userShares = Math.max(0, userShares - event.shares);
            principalBalance = Math.max(0, principalBalance - event.amountUsd);
          }
        }
        if (event.kind === 'fee_mint') {
          totalShares += event.shares;
        }
        if (event.kind === 'profit_credited') {
          cumulativePnl += event.userAmountUsd ?? 0;
        }
      }

      // Anchor at the carried-forward portfolio value for the selected window.
      // If the first deposit is inside the window, this starts at zero.
      points.push({
        time: 'Start',
        balance: principalBalance + cumulativePnl,
        deposit: principalBalance,
        timestamp:
          period === 'ALL' && (firstAuditTs ?? firstPortfolioTs)
            ? Math.max(0, (firstAuditTs ?? firstPortfolioTs ?? 0) - 60_000)
            : periodStart,
      });

      const seenHashes = new Set<string>();

      for (const event of historyEvents) {
        if (event.timestamp < periodStart || event.timestamp > now) continue;
        const isUserEvent = event.owner?.toLowerCase() === portfolioAddress?.toLowerCase();
        // Deduplicate by txHash to prevent PnL double-counting from retries
        if (event.txHash) {
          const dedupeKey = `${event.kind}:${event.txHash}`;
          if (seenHashes.has(dedupeKey)) continue;
          seenHashes.add(dedupeKey);
        }

        if (event.kind === 'deposit') {
          totalShares += event.shares;
          if (isUserEvent) {
            userShares += event.shares;
            principalBalance += event.amountUsd;
          }
        } else if (event.kind === 'withdraw') {
          totalShares = Math.max(0, totalShares - event.shares);
          if (isUserEvent) {
            userShares = Math.max(0, userShares - event.shares);
            principalBalance = Math.max(0, principalBalance - event.amountUsd);
          }
        } else if (event.kind === 'fee_mint') {
          totalShares += event.shares;
          continue;
        } else if (event.kind === 'profit_credited') {
          const userReward = event.userAmountUsd ?? 0;
          cumulativePnl += userReward;
          harvestTotal += userReward;
        } else if (event.kind === 'grid_trade_executed') {
          // pnlDelta is an allocation-indicator in micro-units, NOT a real USD
          // profit figure (see processor.ts: allocationBps / 10000 × 1e6).
          // It is tracked for the grid trade count display only and intentionally
          // excluded from the cumulative PnL balance curve.
          gridTradeCount += 1;
          continue;
        } else {
          continue;
        }

        points.push({
          time: '',
          balance: principalBalance + cumulativePnl,
          deposit: principalBalance,
          timestamp: event.timestamp,
        });
      }

      setAttribution({ harvest: harvestTotal, gridTrades: gridTradeCount });

      // "Now" anchor: uses the ref so it reflects live balance without
      // re-running the full fetch on every block update.
      points.push({
        time: 'Now',
        balance: currentBalanceRef.current + unrealizedYieldRef.current,
        deposit: initialDeposit,
        timestamp: now,
      });

      // Sort chronologically — logs can arrive out of order
      points.sort((a, b) => a.timestamp - b.timestamp);

      // Filter to the selected period; the anchor was placed at period-start
      // so it is always included after filtering.
      let filtered =
        period === 'ALL'
          ? points
          : points.filter(p => now - p.timestamp <= windowMs);

      // Safety net: keep the selected window intact instead of falling back to
      // all historical points, which would make the range buttons misleading.
      if (filtered.length < 2 && period !== 'ALL') {
        filtered = [
          {
            time: 'Start',
            balance: 0,
            deposit: 0,
            timestamp: now - windowMs,
          },
          {
            time: 'Now',
            balance: currentBalanceRef.current + unrealizedYieldRef.current,
            deposit: initialDeposit,
            timestamp: now,
          },
        ];
      }

      const finalData = filtered.map(p => ({
        ...p,
        time:
          p.time === 'Now' || p.time === 'Start'
            ? p.time
            : formatChartTime(p.timestamp, period),
      }));

      setData(finalData);
    } catch (err) {
      console.error('[PnlChart] Failed to fetch chart history:', err);
      // Fallback: two-point flat line using real timestamps
      const fallbackNow = Date.now();
      setData([
        { time: 'Start', balance: portfolioAddress ? 0 : initialDeposit, deposit: portfolioAddress ? 0 : initialDeposit, timestamp: fallbackNow - 86_400_000 },
        { time: 'Now', balance: currentBalanceRef.current + unrealizedYieldRef.current, deposit: initialDeposit, timestamp: fallbackNow },
      ]);
    } finally {
      setLoading(false);
    }
  }, [userAddress, portfolioAddress, initialDeposit, period, chainId]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch on mount and whenever the address, initial deposit, or period changes.
  // currentBalance and unrealizedYield are intentionally excluded — they change
  // every block and would trigger 30+ API calls per minute. The "Now" point
  // reads them via refs instead.
  useEffect(() => {
    fetchHistory();
    const id = setInterval(fetchHistory, CHART_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchHistory]);

  if (!mounted) return null;

  return (
    <div className="ys-card p-10 flex flex-col gap-10 h-full bg-[#0B0F0D] group/chart relative overflow-hidden">
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
          <div key={label} className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.04] space-y-2 hover:bg-white/[0.04] transition-all">
            <div className="flex items-center gap-2">
              {icon}
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">{label}</p>
            </div>
            <p className={`text-2xl font-heading font-bold ${color} tracking-tight`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
        {/* Attribution breakdown */}
        <div className="space-y-6 relative flex flex-col justify-center">
          <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] mb-2">Yield Attribution</p>
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-[#F5F7FA] font-heading font-bold">
                  <Zap size={14} className="text-[#00FFA3]" />
                  Protocol Harvests
                </div>
                <span className={`font-mono font-bold ${attribution.harvest >= 0 ? 'text-[#00FFA3]' : 'text-[#FF4466]'}`}>
                  {attribution.harvest >= 0 ? '+' : ''}${attribution.harvest.toFixed(2)}
                </span>
              </div>
              <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-[#00FFA3]" style={{ width: '100%' }} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-[#F5F7FA] font-heading font-bold">
                  <ArrowUpDown size={14} className="text-[#C2E812]" />
                  Grid Trades
                </div>
                <span className="text-[#C2E812] font-mono font-bold">
                  {attribution.gridTrades} executed
                </span>
              </div>
              <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-[#C2E812]" style={{ width: attribution.gridTrades > 0 ? '100%' : '0%' }} />
              </div>
            </div>
          </div>
        </div>

        {/* Chart area */}
        <div className="relative min-h-[300px]">
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
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(value) => formatChartTime(Number(value), period)}
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
            className="p-2 rounded-lg bg-white/5 border border-white/10 text-[#484F58] hover:text-[#C2E812] transition-all"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
