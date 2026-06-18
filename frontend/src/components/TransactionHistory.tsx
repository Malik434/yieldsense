'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ExternalLink, Zap, ArrowUpDown, Search, RefreshCw, Clock, LogOut } from 'lucide-react';
import { usePublicClient } from 'wagmi';
import { OPERATOR_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
import { useNetwork } from '@/providers/NetworkProvider';

interface TxEvent {
  type: 'HARVEST' | 'TRADE' | 'DEPOSIT' | 'WITHDRAW';
  timestamp: number;
  txHash: string;
  amount?: number;
  pnlDelta?: number;
  chainId?: number;
}

interface TelemetryEvent {
  event?: string;
  timestamp?: number;
  txHash?: string;
  chainId?: number | string;
  CHAIN_ID?: number | string;
  profitCreditedUsd?: number | string;
  estimatedRewardUsd?: number | string;
  pnlDelta?: number | string;
}

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
  const { chainId: activeChainId, config } = useNetwork();
  const [txs, setTxs] = useState<TxEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const publicClient = usePublicClient({ chainId: activeChainId });
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  const demoTxs = useMemo<TxEvent[]>(() => {
    const now = Date.now();
    return [
      {
        type: 'TRADE',
        timestamp: now - 90_000,
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000001',
        pnlDelta: 0.38,
        chainId: activeChainId,
      },
      {
        type: 'HARVEST',
        timestamp: now - 210_000,
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000002',
        amount: 0.24,
        chainId: activeChainId,
      },
      {
        type: 'DEPOSIT',
        timestamp: now - 420_000,
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000003',
        amount: 1,
        chainId: activeChainId,
      },
    ];
  }, [activeChainId]);

  const fetchTxs = useCallback(async () => {
    if (!publicClient) {
      setLoading(false);
      return;
    }
    
    try {
      const latestBlock = await publicClient.getBlockNumber();
      const deploymentBlock = config.deploymentBlock;
      
      // Public RPCs like Base often limit eth_getLogs to 10,000 blocks per request.
      const CHUNK_SIZE = BigInt(10000);
      // We look back up to 100,000 blocks (~55 hours on Base) or until deployment.
      const MAX_HISTORY = BigInt(100000);
      
      const fromBlock = (latestBlock - deploymentBlock) > MAX_HISTORY
        ? latestBlock - MAX_HISTORY
        : deploymentBlock;

      let allHarvestLogs: any[] = [];
      let allTradeLogs: any[] = [];

      // Fetch in chunks to avoid RPC limit errors
      for (let i = fromBlock; i <= latestBlock; i += CHUNK_SIZE + BigInt(1)) {
        const chunkTo = i + CHUNK_SIZE > latestBlock ? latestBlock : i + CHUNK_SIZE;
        
        const [hLogs, tLogs] = await Promise.all([
          publicClient.getContractEvents({
            address: config.keeper,
            abi: KEEPER_ABI,
            eventName: 'HarvestExecuted',
            fromBlock: i,
            toBlock: chunkTo,
          }),
          publicClient.getContractEvents({
            address: config.keeper,
            abi: KEEPER_ABI,
            eventName: 'TradeExecuted',
            args: { user: OPERATOR_ADDRESS },
            fromBlock: i,
            toBlock: chunkTo,
          })
        ]);
        
        allHarvestLogs = [...allHarvestLogs, ...hLogs];
        allTradeLogs = [...allTradeLogs, ...tLogs];
      }

      const allRawLogs = [...allHarvestLogs, ...allTradeLogs];
      const uniqueBlockNumbers = Array.from(new Set(allRawLogs.map(l => l.blockNumber)));
      
      const blockMap = new Map<bigint, number>();
      await Promise.all(uniqueBlockNumbers.map(async (bn) => {
        try {
          const block = await publicClient.getBlock({ blockNumber: bn });
          blockMap.set(bn, Number(block.timestamp));
        } catch (e) {
          console.error(`Failed to fetch block ${bn}`, e);
        }
      }));

      const mapped = allRawLogs.map((log): TxEvent | null => {
        const timestamp = blockMap.get(log.blockNumber) || 0;
        const txHash = log.transactionHash;
        
        if (log.eventName === 'HarvestExecuted') {
          return {
            type: 'HARVEST',
            timestamp: timestamp * 1000,
            txHash,
            amount: Number(log.args.profitCredited ?? 0) / 1e6,
            chainId: activeChainId
          };
        } else if (log.eventName === 'TradeExecuted') {
          return {
            type: 'TRADE',
            timestamp: timestamp * 1000,
            txHash,
            pnlDelta: Number(log.args.pnlDelta ?? 0) / 1e6,
            chainId: activeChainId
          };
        }
        return null;
      }).filter((t): t is TxEvent => t !== null);

      // Sort by timestamp descending
      mapped.sort((a, b) => b.timestamp - a.timestamp);
      
      setTxs(mapped);
    } catch (err) {
      console.error('[TransactionHistory] Fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [activeChainId, config, publicClient]);

  useEffect(() => {
    if (isDemoMode) setLoading(false);
    const initialFetch = setTimeout(fetchTxs, 0);
    const id = setInterval(fetchTxs, 60_000) // Poll every 60s;
    return () => {
      clearTimeout(initialFetch);
      clearInterval(id);
    };
  }, [fetchTxs, isDemoMode]);

  const visibleTxs = isDemoMode && txs.length === 0 ? demoTxs : txs;
  const isShowingDemoTxs = isDemoMode && txs.length === 0;

  return (
    <div className="flex flex-col gap-6 mt-10 sm:mt-12 animate-fade-in">
      <div className="flex flex-col gap-4 border-b border-white/[0.05] pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 p-2.5 rounded-xl bg-white/5 border border-white/10">
            <Clock size={18} className="text-[#C2E812]" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Guardian Ledger</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Execution History</h3>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">
            {isShowingDemoTxs ? 'Demo dry-run feed' : 'Real-time sync'}
          </span>
          <div className="w-2 h-2 rounded-full bg-[#00FFA3] animate-pulse" />
        </div>
      </div>

      <div className="ys-card bg-[#0B0F0D]/50 border border-white/[0.05] rounded-[24px] sm:rounded-[32px] overflow-hidden flex flex-col">
        <div className="hidden md:grid grid-cols-6 gap-4 px-8 py-5 bg-white/[0.02] border-b border-white/[0.05] shrink-0">
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em]">Timestamp</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] md:col-span-1">Processor</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] md:col-span-2">Execution Details</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] hidden md:block">Account</span>
          <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] text-right">Receipt</span>
        </div>

        <div className="flex flex-col divide-y divide-white/[0.03] max-h-[520px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <RefreshCw size={32} className="text-[#C2E812] animate-spin opacity-40" />
            </div>
          ) : visibleTxs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-6 opacity-30 grayscale">
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
                <Search size={32} className="text-[#484F58]" />
              </div>
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">No execution history detected</p>
            </div>
          ) : (
            visibleTxs.map((tx, i) => {
              const cfg = TYPE_CONFIG[tx.type];
              const date = new Date(tx.timestamp);
              const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
              const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
              const isDemoTx = tx.txHash.startsWith('0xdemo');
              
              return (
                <div 
                  key={`${tx.txHash}-${i}`} 
                  className="flex flex-col gap-5 px-5 py-6 hover:bg-white/[0.01] transition-all group sm:px-6 md:grid md:grid-cols-6 md:items-center md:gap-4 md:px-8"
                >
                  <div className="flex items-start justify-between gap-4 md:block">
                    <div className="flex flex-col">
                      <span className="text-sm font-heading font-bold text-[#F5F7FA]">{timeStr}</span>
                      <span className="text-[10px] font-mono text-[#484F58]">{dateStr}</span>
                    </div>
                    <span className={`md:hidden text-[9px] font-mono font-bold px-2 py-1 rounded border uppercase tracking-widest ${tx.type === 'TRADE' ? 'bg-[#C2E812]/10 text-[#C2E812] border-[#C2E812]/20' : 'bg-[#00FFA3]/10 text-[#00FFA3] border-[#00FFA3]/20'}`}>
                      {cfg.label}
                    </span>
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
                    <span className="text-xs font-heading font-bold text-[#8B949E]">
                      {tx.type === 'HARVEST' ? 'TEE-Guardian' : 'Grid-Executor'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <span className="text-sm font-heading font-bold text-[#F5F7FA] break-words">
                        {isDemoTx
                          ? tx.type === 'TRADE'
                            ? `Grid evaluation +$${tx.pnlDelta?.toFixed(2)}`
                            : tx.type === 'DEPOSIT'
                              ? `Deposit: $${tx.amount?.toFixed(2)}`
                              : `harvest candidate: $${tx.amount?.toFixed(2)}`
                          : tx.type === 'TRADE'
                            ? `Audit signal ${tx.pnlDelta?.toFixed(4)}`
                            : tx.amount != null
                              ? `Credited $${tx.amount.toFixed(4)}`
                              : 'Optimization & Compounding'}
                      </span>
                      <span className={`hidden sm:inline-flex w-fit text-[9px] font-mono font-bold px-2 py-0.5 rounded border uppercase tracking-widest ${tx.type === 'TRADE' ? 'bg-[#C2E812]/10 text-[#C2E812] border-[#C2E812]/20' : 'bg-[#00FFA3]/10 text-[#00FFA3] border-[#00FFA3]/20'}`}>
                        {cfg.label}
                      </span>
                    </div>
                  </div>

                  <div className="hidden md:flex items-center gap-3">
                    <div className="w-6 h-6 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[9px] font-bold text-[#484F58]">Y</div>
                    <span className="text-xs font-mono font-bold text-[#484F58]">{shortHash(OPERATOR_ADDRESS)}</span>
                  </div>

                    <div className="flex justify-end md:justify-end">
                      {isDemoTx ? (
                        <span className="inline-flex items-center gap-2 rounded-xl border border-[#C2E812]/20 bg-[#C2E812]/10 px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#C2E812]">
                          Dry run
                        </span>
                      ) : (
                        <a 
                          href={`${config.explorer}/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 p-2.5 rounded-xl bg-white/5 md:bg-white/0 hover:bg-white/5 border border-white/10 md:border-transparent hover:border-white/10 text-[#484F58] hover:text-[#C2E812] transition-all group/link"
                        >
                          <span className="text-[10px] font-mono font-bold uppercase tracking-widest md:hidden">Receipt</span>
                          <ExternalLink size={16} className="group-hover/link:scale-110 transition-transform" />
                        </a>
                      )}
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
