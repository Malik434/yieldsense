'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, ExternalLink, Zap, ArrowUpDown, Search, RefreshCw, LogOut, Clock } from 'lucide-react';
import { OPERATOR_ADDRESS } from '@/lib/contracts';

interface TxEvent {
  type: 'HARVEST' | 'TRADE' | 'DEPOSIT' | 'WITHDRAW';
  timestamp: number;
  txHash: string;
  amount?: number;
  pnlDelta?: number;
}

const BLOCKSCOUT = 'https://base-sepolia.blockscout.com';

function shortHash(hash: string): string {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

const TYPE_CONFIG = {
  HARVEST: { label: 'Harvest', color: '#00FFA3', icon: <Zap size={14} /> },
  TRADE: { label: 'Grid Trade', color: '#C2E812', icon: <ArrowUpDown size={14} /> },
  DEPOSIT: { label: 'Deposit', color: '#0052FF', icon: <ShieldCheck size={14} /> },
  WITHDRAW: { label: 'Withdraw', color: '#FF4466', icon: <LogOut size={14} /> },
};

export function TransactionHistory() {
  const [txs, setTxs] = useState<TxEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTxs = async () => {
    try {
      const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}`);
      if (!res.ok) return;
      const data = await res.json();
      const logs: any[] = data.logs ?? [];
      
      const mapped = logs.map(log => {
        const ts = (log.timestamp ?? 0) * 1000;
        const txHash = log.txHash ?? '';
        if (!txHash) return null;

        if (log.event === 'harvest_confirmed' || log.event === 'harvest_submitted') {
          return { type: 'HARVEST', timestamp: ts, txHash };
        }
        if (log.event === 'grid_trade_executed') {
          const pnlRaw = log.pnlDelta ? Number(log.pnlDelta) / 1_000_000 : 0;
          return { type: 'TRADE', timestamp: ts, txHash, pnlDelta: pnlRaw };
        }
        return null;
      }).filter((t): t is TxEvent => t !== null);

      setTxs(mapped);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTxs();
    const id = setInterval(fetchTxs, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-6 mt-12 animate-fade-in">
      <div className="flex items-center justify-between border-b border-white/[0.05] pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <Clock size={18} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Guardian Ledger</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Execution History</h3>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Real-time sync</span>
          <div className="w-2 h-2 rounded-full bg-[#00FFA3] animate-pulse" />
        </div>
      </div>

      <div className="ys-card bg-[#0B0F0D]/50 border border-white/[0.05] rounded-[32px] overflow-hidden">
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4 px-8 py-5 bg-white/[0.02] border-b border-white/[0.05]">
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em]">Timestamp</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] md:col-span-1">Processor</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] md:col-span-2">Execution Details</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] hidden md:block">Account</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] text-right">Receipt</span>
        </div>

        <div className="flex flex-col divide-y divide-white/[0.03]">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <RefreshCw size={32} className="text-[#C2E812] animate-spin opacity-40" />
            </div>
          ) : txs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-6 opacity-30 grayscale">
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
                <Search size={32} className="text-[#484F58]" />
              </div>
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">No execution history detected</p>
            </div>
          ) : (
            txs.map((tx, i) => {
              const cfg = TYPE_CONFIG[tx.type];
              const date = new Date(tx.timestamp);
              const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
              const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
              
              return (
                <div 
                  key={`${tx.txHash}-${i}`} 
                  className="grid grid-cols-4 md:grid-cols-6 gap-4 px-8 py-6 items-center hover:bg-white/[0.01] transition-all group"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-heading font-bold text-[#F5F7FA]">{timeStr}</span>
                    <span className="text-[10px] font-mono text-[#484F58]">{dateStr}</span>
                  </div>
                  
                  <div className="flex items-center gap-3 md:col-span-1">
                    <div className="w-9 h-9 rounded-xl bg-black border border-white/10 flex items-center justify-center overflow-hidden shadow-inner">
                      {tx.type === 'HARVEST' ? (
                        <div className="w-full h-full bg-gradient-to-br from-[#00FFA3] to-[#C2E812]" />
                      ) : (
                        <div className="w-full h-full bg-[#1C212E] flex items-center justify-center">
                          <ArrowUpDown size={14} className="text-[#C2E812]" />
                        </div>
                      )}
                    </div>
                    <span className="text-xs font-heading font-bold text-[#8B949E] hidden md:block">
                      {tx.type === 'HARVEST' ? 'TEE-Guardian' : 'Grid-Executor'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-heading font-bold text-[#F5F7FA]">
                        {tx.type === 'TRADE' ? `Settled +${tx.pnlDelta?.toFixed(4)} USDC` : 'Optimization & Compounding'}
                      </span>
                      <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border uppercase tracking-widest ${tx.type === 'TRADE' ? 'bg-[#C2E812]/10 text-[#C2E812] border-[#C2E812]/20' : 'bg-[#00FFA3]/10 text-[#00FFA3] border-[#00FFA3]/20'}`}>
                        {cfg.label}
                      </span>
                    </div>
                  </div>

                  <div className="hidden md:flex items-center gap-3">
                    <div className="w-6 h-6 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[9px] font-bold text-[#484F58]">Y</div>
                    <span className="text-xs font-mono font-bold text-[#484F58]">{shortHash(OPERATOR_ADDRESS)}</span>
                  </div>

                  <div className="flex justify-end">
                    <a 
                      href={`${BLOCKSCOUT}/tx/${tx.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2.5 rounded-xl bg-white/0 hover:bg-white/5 border border-transparent hover:border-white/10 text-[#484F58] hover:text-[#C2E812] transition-all group/link"
                    >
                      <ExternalLink size={16} className="group-hover/link:scale-110 transition-transform" />
                    </a>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
