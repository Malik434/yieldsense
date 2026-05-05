'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWriteContract, useChainId } from 'wagmi';
import { parseUnits } from 'viem';
import { baseSepolia } from 'wagmi/chains';
import { Terminal, Droplets, ArrowRight, CheckCircle2, ShieldCheck, Loader2, Zap, Cpu, TerminalSquare } from 'lucide-react';
import { MOCK_USDC_ABI, ASSET_ADDRESS, OPERATOR_ADDRESS } from '@/lib/contracts';

interface HardwareLog {
  timestamp: number;
  type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC';
  message: string;
  txHash?: string;
}

export function TestingSuite() {
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const isTestnet = chainId === baseSepolia.id;
  const [logs, setLogs] = useState<HardwareLog[]>([]);
  const [minting, setMinting] = useState(false);
  const [mintSuccess, setMintSuccess] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}`);
        if (res.ok) {
          const data = await res.json();
          if (data.logs && Array.isArray(data.logs)) {
            const mappedLogs = data.logs.map((log: any) => {
              let type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC' = 'EXECUTION';
              if (log.event === 'processor_heartbeat') type = 'ATTESTATION';
              if (log.event === 'harvest_confirmed' || log.event === 'harvest_submitted') type = 'STORAGE_SYNC';

              let message = log.message || log.event;
              if (log.event === 'profitability_check') message = `Yield checked: ${log.reason} (APR: ${((log.apr || 0) * 100).toFixed(2)}%)`;
              if (log.event === 'force_test_bypass') message = 'Force test bypass enabled, skipping yield checks';
              if (log.event === 'harvest_submitted') message = `Harvest transaction submitted`;
              if (log.event === 'harvest_confirmed') message = `Harvest transaction confirmed`;
              if (log.event === 'hw_address_report') message = `Acurast Hardware Address: ${log.hwAddress}`;

              return {
                timestamp: log.timestamp ? log.timestamp * 1000 : Date.now(),
                type,
                message,
                txHash: log.txHash
              };
            });
            setLogs(mappedLogs.reverse());
          }
        }
      } catch { }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleMint = async () => {
    if (!isConnected || minting) return;
    setMinting(true);
    setMintSuccess(false);
    try {
      await writeContractAsync({
        address: ASSET_ADDRESS,
        abi: MOCK_USDC_ABI,
        functionName: 'mint',
        args: [parseUnits('1000', 6)],
      });
      setMintSuccess(true);
      setTimeout(() => setMintSuccess(false), 3000);
    } catch (e) {
      console.error(e);
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="flex flex-col gap-10 mt-24">
      {/* Testnet Header */}
      <div className="flex items-center justify-between border-b border-white/[0.05] pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <TerminalSquare size={18} className="text-[#00FFA3]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Hardware Debug</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">System Integrity Logs</h3>
          </div>
        </div>
        {isTestnet && (
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-xl bg-[#00FFA3]/10 border border-[#00FFA3]/20 text-[10px] font-mono font-bold text-[#00FFA3] uppercase tracking-widest">
            <Zap size={12} />
            Sepolia Testnet Active
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        {/* Faucet Controls */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div className="ys-card p-8 flex flex-col gap-6 bg-[#0B0F0D]/40">
            <div className="flex items-center gap-3">
              <Droplets size={20} className="text-[#00d4ff]" />
              <span className="text-[10px] font-mono font-bold text-[#F5F7FA] uppercase tracking-widest">Testnet Provisioning</span>
            </div>

            <p className="text-[11px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
              Acquire Mock USDC and Sepolia ETH to verify the autonomous harvest cycle.
            </p>

            <div className="space-y-4">
              <button
                onClick={handleMint}
                disabled={!isConnected || minting || !isTestnet}
                className={`w-full flex items-center justify-between p-5 rounded-2xl border transition-all ${mintSuccess
                    ? 'bg-[#00FFA3]/10 border-[#00FFA3]/30 text-[#00FFA3]'
                    : 'bg-white/5 border-white/10 text-[#F5F7FA] hover:border-[#00d4ff]/30 hover:bg-[#00d4ff]/5'
                  }`}
              >
                <div className="flex flex-col items-start">
                  <span className="text-xs font-heading font-bold">Mock USDC</span>
                  <span className="text-[9px] font-mono text-[#484F58] uppercase">1,000.00 Tokens</span>
                </div>
                {minting ? <Loader2 size={16} className="animate-spin" /> :
                  mintSuccess ? <CheckCircle2 size={16} /> : <ArrowRight size={16} className="text-[#484F58]" />}
              </button>

              <a
                href="https://portal.cdp.coinbase.com/products/faucet"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-between p-5 rounded-2xl bg-white/5 border border-white/10 text-[#F5F7FA] hover:border-[#C2E812]/30 hover:bg-[#C2E812]/5 transition-all"
              >
                <div className="flex flex-col items-start">
                  <span className="text-xs font-heading font-bold">Base Sepolia ETH</span>
                  <span className="text-[9px] font-mono text-[#484F58] uppercase">Gas Faucet</span>
                </div>
                <ExternalLink size={16} className="text-[#484F58]" />
              </a>
            </div>
          </div>

          <div className="ys-card p-8 bg-gradient-to-br from-[#C2E812]/5 to-transparent border-[#C2E812]/10">
            <div className="flex items-center gap-3 mb-4">
              <ShieldCheck size={16} className="text-[#C2E812]" />
              <span className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-widest">Verification Status</span>
            </div>
            <p className="text-[11px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
              Connected Acurast Enclave is reporting synchronized state. All decision logic is hardware-attested.
            </p>
          </div>
        </div>

        {/* Console Logs */}
        <div className="lg:col-span-2 ys-card p-0 bg-black overflow-hidden flex flex-col min-h-[450px] border-white/[0.05]">
          <div className="flex items-center justify-between p-5 border-b border-white/[0.05] bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[#00FFA3] animate-pulse" />
              <span className="text-[10px] font-mono font-bold text-[#F5F7FA] uppercase tracking-[0.2em]">Live Telemetry Stream</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-[9px] font-mono text-[#484F58] uppercase font-bold tracking-widest">Buffer: {logs.length} events</span>
              <div className="h-4 w-px bg-white/10" />
              <Cpu size={14} className="text-[#484F58]" />
            </div>
          </div>

          <div
            ref={scrollContainerRef}
            className="flex-1 p-8 overflow-y-auto font-mono text-[11px] space-y-3 scrollbar-hide"
          >
            {logs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[#484F58] animate-pulse uppercase tracking-[0.3em]">
                Initializing secure channel...
              </div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="flex items-start gap-4 animate-slide-in-right" style={{ animationDelay: `${i * 0.05}s` }}>
                  <span className="text-[#484F58] shrink-0 font-bold">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`shrink-0 font-bold px-2 py-0.5 rounded text-[9px] ${log.type === 'ATTESTATION' ? 'text-[#00FFA3] bg-[#00FFA3]/5' :
                      log.type === 'STORAGE_SYNC' ? 'text-[#C2E812] bg-[#C2E812]/5' :
                        'text-[#00d4ff] bg-[#00d4ff]/5'
                    }`}>
                    [{log.type}]
                  </span>
                  <span className="text-[#F5F7FA] leading-relaxed opacity-90">
                    {log.message}
                    {log.txHash && (
                      <a
                        href={`https://base-sepolia.blockscout.com/tx/${log.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-3 text-[#C2E812] hover:underline"
                      >
                        VIEW RECEIPT ↗
                      </a>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExternalLink({ size, className }: { size: number, className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
