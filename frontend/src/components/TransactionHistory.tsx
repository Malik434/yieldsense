'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, ExternalLink, RefreshCw, Zap, ArrowUpDown } from 'lucide-react';

interface TxEvent {
  type: 'HARVEST' | 'TRADE' | 'DEPOSIT' | 'WITHDRAW';
  timestamp: number;
  txHash: string;
  amount?: number;
  pnlDelta?: number;
}

const MOCK_TXS: TxEvent[] = [
  { type: 'HARVEST', timestamp: Date.now() - 3 * 60 * 60 * 1000, txHash: '0xabc1...f23e', amount: 0.0042 },
  { type: 'TRADE', timestamp: Date.now() - 7 * 60 * 60 * 1000, txHash: '0xdef4...a91c', pnlDelta: 0.0018 },
  { type: 'HARVEST', timestamp: Date.now() - 14 * 60 * 60 * 1000, txHash: '0x7c3b...882a', amount: 0.0031 },
  { type: 'TRADE', timestamp: Date.now() - 22 * 60 * 60 * 1000, txHash: '0x55ef...c104', pnlDelta: -0.0005 },
  { type: 'DEPOSIT', timestamp: Date.now() - 26 * 60 * 60 * 1000, txHash: '0x1290...db7f', amount: 1.0 },
];

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const TYPE_CONFIG = {
  HARVEST: { label: 'HARVEST', color: '#00ff9f', bg: 'rgba(0,255,159,0.08)', border: 'rgba(0,255,159,0.25)', icon: <Zap size={10} /> },
  TRADE: { label: 'TRADE', color: '#00d4ff', bg: 'rgba(0,212,255,0.08)', border: 'rgba(0,212,255,0.25)', icon: <ArrowUpDown size={10} /> },
  DEPOSIT: { label: 'DEPOSIT', color: '#a78bfa', bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.25)', icon: <RefreshCw size={10} /> },
  WITHDRAW: { label: 'WITHDRAW', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', icon: <RefreshCw size={10} /> },
};

export function TransactionHistory() {
  const [txs, setTxs] = useState<TxEvent[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTxs(MOCK_TXS);
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
        {txs.map((tx, i) => {
          const cfg = TYPE_CONFIG[tx.type];
          const amount = tx.type === 'TRADE'
            ? `${tx.pnlDelta && tx.pnlDelta >= 0 ? '+' : ''}${tx.pnlDelta?.toFixed(4)}`
            : `+${tx.amount?.toFixed(4)}`;
          const amountColor = tx.type === 'TRADE' && tx.pnlDelta && tx.pnlDelta < 0 ? '#ff4466' : '#00ff9f';

          return (
            <div
              key={i}
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

              {/* TX Hash */}
              <div className="flex justify-end">
                <a
                  href={`https://base.blockscout.com/tx/${tx.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 font-mono text-[10px] transition-all"
                  style={{ color: '#334155' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#00d4ff')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = '#334155')}
                >
                  {tx.txHash.slice(0, 8)}...
                  <ExternalLink size={10} />
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Acurast verified footer */}
      <div
        className="flex items-center justify-center gap-2 py-2 rounded-lg"
        style={{ background: 'rgba(0,255,159,0.04)', border: '1px solid rgba(0,255,159,0.1)' }}
      >
        <ShieldCheck size={11} style={{ color: '#00ff9f', opacity: 0.6 }} />
        <span className="font-mono text-[10px] tracking-widest" style={{ color: '#334155' }}>
          ALL TRANSACTIONS AUTHORIZED BY ACURAST TEE
        </span>
      </div>
    </div>
  );
}
