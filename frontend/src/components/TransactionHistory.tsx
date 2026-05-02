'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, ExternalLink, RefreshCw, Zap, ArrowUpDown, Clock } from 'lucide-react';
import { OPERATOR_ADDRESS } from '@/lib/contracts';

interface TxEvent {
  type: 'HARVEST' | 'TRADE' | 'DEPOSIT' | 'WITHDRAW';
  timestamp: number;
  txHash: string;
  amount?: number;
  pnlDelta?: number;
}

const BLOCKSCOUT = 'https://base-sepolia.blockscout.com';

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortHash(hash: string): string {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

const TYPE_CONFIG = {
  HARVEST: { label: 'HARVEST', color: '#00ff9f', bg: 'rgba(0,255,159,0.08)', border: 'rgba(0,255,159,0.25)', icon: <Zap size={10} /> },
  TRADE: { label: 'TRADE', color: '#00d4ff', bg: 'rgba(0,212,255,0.08)', border: 'rgba(0,212,255,0.25)', icon: <ArrowUpDown size={10} /> },
  DEPOSIT: { label: 'DEPOSIT', color: '#a78bfa', bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.25)', icon: <RefreshCw size={10} /> },
  WITHDRAW: { label: 'WITHDRAW', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', icon: <RefreshCw size={10} /> },
};

/** Map a raw telemetry event (from /api/state logs) to a TxEvent for display. */
function mapLogToTx(log: any): TxEvent | null {
  const ts = (log.timestamp ?? 0) * 1000;
  const txHash = log.txHash ?? '';
  if (!txHash) return null;

  switch (log.event) {
    case 'harvest_confirmed':
    case 'harvest_submitted':
      return { type: 'HARVEST', timestamp: ts, txHash };

    case 'grid_trade_executed': {
      const pnlRaw = log.pnlDelta ? Number(log.pnlDelta) / 1_000_000 : 0;
      return { type: 'TRADE', timestamp: ts, txHash, pnlDelta: pnlRaw };
    }

    default:
      return null;
  }
}

export function TransactionHistory() {
  const [txs, setTxs] = useState<TxEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  // Always fetch from OPERATOR_ADDRESS — harvest txs are shared across all vault depositors.
  const fetchTxs = async () => {
    try {
      const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}`);
      if (!res.ok) return;
      const data = await res.json();
      const logs: any[] = data.logs ?? [];
      const mapped = logs.map(mapLogToTx).filter((t): t is TxEvent => t !== null);

      // Deduplicate by txHash to prevent double-counting submitted vs confirmed
      const unique = Array.from(
        mapped.reduce((map, tx) => {
          // If we have both, confirmed usually comes later (higher timestamp), 
          // so we keep the first one we find in the descending-order list.
          if (!map.has(tx.txHash)) {
            map.set(tx.txHash, tx);
          }
          return map;
        }, new Map<string, TxEvent>()).values()
      );

      setTxs(unique);
    } catch {
      // silently keep last state on network error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    fetchTxs();
    const id = setInterval(fetchTxs, 10_000);
    return () => clearInterval(id);
  }, []);

  if (!mounted) return null;

  return (
    <div className="cyber-card p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={15} style={{ color: '#00ff9f' }} />
          <span className="neon-label">ACURAST-VERIFIED TRANSACTIONS</span>
        </div>
        <span className="status-badge verified">
          <ShieldCheck size={9} />
          ON-CHAIN VERIFIED
        </span>
      </div>

      {/* Table header */}
      <div
        className="grid font-mono text-[10px] tracking-widest pb-2"
        style={{
          color: '#334155',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          gridTemplateColumns: '100px 1fr 1fr 1fr',
        }}
      >
        <span>TYPE</span>
        <span>AMOUNT / PnL</span>
        <span>TIME</span>
        <span className="text-right">TX HASH</span>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6">
            <Clock size={13} style={{ color: '#475569' }} />
            <span className="font-mono text-xs" style={{ color: '#475569' }}>Fetching on-chain events...</span>
          </div>
        ) : txs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <span className="font-mono text-xs" style={{ color: '#334155' }}>No on-chain events yet.</span>
            <span className="font-mono text-[10px]" style={{ color: '#1e293b' }}>
              Events appear here once the Acurast worker submits a harvest or trade.
            </span>
          </div>
        ) : (
          txs.map((tx, i) => {
            const cfg = TYPE_CONFIG[tx.type];
            const amount =
              tx.type === 'TRADE'
                ? `${tx.pnlDelta != null && tx.pnlDelta >= 0 ? '+' : ''}${tx.pnlDelta?.toFixed(4)} USDC`
                : tx.amount != null
                  ? `+${tx.amount.toFixed(4)} USDC`
                  : '—';
            const amountColor =
              tx.type === 'TRADE' && tx.pnlDelta != null && tx.pnlDelta < 0 ? '#ff4466' : '#00ff9f';

            return (
              <div
                key={`${tx.txHash}-${i}`}
                className="grid items-center rounded-lg px-3 py-2.5 transition-all"
                style={{
                  gridTemplateColumns: '100px 1fr 1fr 1fr',
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid rgba(255,255,255,0.04)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(0,255,159,0.15)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.04)')}
              >
                {/* Type badge */}
                <div className="flex items-center gap-1.5">
                  <span
                    className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[9px] font-bold tracking-widest"
                    style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}
                  >
                    {cfg.icon}
                    {cfg.label}
                  </span>
                </div>

                {/* Amount */}
                <span className="font-mono text-xs font-semibold" style={{ color: amountColor }}>
                  {amount}
                </span>

                {/* Time */}
                <span className="font-mono text-xs" style={{ color: '#475569' }}>
                  {timeAgo(tx.timestamp)}
                </span>

                {/* TX Hash — links to Base Sepolia Blockscout */}
                <div className="flex justify-end">
                  <a
                    href={`${BLOCKSCOUT}/tx/${tx.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 font-mono text-[10px] transition-all"
                    style={{ color: '#334155' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#00d4ff')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#334155')}
                  >
                    {shortHash(tx.txHash)}
                    <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Acurast verified footer */}
      <div
        className="flex items-center justify-center gap-2 py-2 rounded-lg"
        style={{ background: 'rgba(0,255,159,0.04)', border: '1px solid rgba(0,255,159,0.1)' }}
      >
        <ShieldCheck size={11} style={{ color: '#00ff9f', opacity: 0.6 }} />
        <span className="font-mono text-[10px] tracking-widest" style={{ color: '#334155' }}>
          ALL TRANSACTIONS AUTHORIZED BY ACURAST TEE · BASE SEPOLIA
        </span>
      </div>
    </div>
  );
}
