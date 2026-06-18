'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useWriteContract } from 'wagmi';
import { parseUnits } from 'viem';
import { baseSepolia } from 'wagmi/chains';
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  Droplets,
  Loader2,
  ShieldCheck,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import { MOCK_USDC_ABI, OPERATOR_ADDRESS, BUILDER_CODE_SUFFIX } from '@/lib/contracts';
import { useNetwork } from '@/providers/NetworkProvider';

interface HardwareLog {
  timestamp: number;
  type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC' | 'ERROR';
  message: string;
  txHash?: string;
}

interface TelemetryLog {
  event?: string;
  timestamp?: number;
  message?: string;
  txHash?: string;
  chainId?: number | string;
  stage?: string;
  keeperAddress?: string;
  activeGridLevels?: number;
  configuredGridLevels?: number;
  reason?: string;
  currentPrice?: number | string;
  pendingTrades?: number;
  nonce?: number | string;
  submittedTrades?: number;
  status?: string;
  apr?: number;
  hwAddress?: string;
}

function formatStageMessage(log: TelemetryLog): string {
  switch (log.stage) {
    case 'start':
      return `Processor started: keeper ${String(log.keeperAddress ?? '').slice(0, 10)}...`;
    case 'network_ready':
      return `Execution RPC ready on chain ${log.chainId}`;
    case 'strategy_loaded':
      return `Strategy loaded: ${log.activeGridLevels ?? 0}/${log.configuredGridLevels ?? 0} active grid levels`;
    case 'no_active_grid_levels':
      return `Grid skipped: ${log.reason ?? 'no active levels'}`;
    case 'pool_price_observed':
      return `Pool price observed: ${Number(log.currentPrice ?? 0).toFixed(6)}`;
    case 'trade_evaluation_complete':
      return `Trade evaluation complete: ${log.pendingTrades ?? 0} pending trades`;
    case 'trade_submit_start':
      return `Submitting grid trade nonce ${log.nonce}`;
    case 'complete':
      return `Processor completed: ${log.status ?? 'ok'} (${log.submittedTrades ?? 0} submitted)`;
    default:
      return `Processor stage: ${log.stage ?? 'unknown'}`;
  }
}

function mapTelemetryLog(log: TelemetryLog): HardwareLog {
  let type: HardwareLog['type'] = 'EXECUTION';
  if (log.event === 'processor_heartbeat') type = 'ATTESTATION';
  if (log.event === 'harvest_confirmed' || log.event === 'harvest_submitted') type = 'STORAGE_SYNC';
  if (log.event === 'runtime_error' || log.event === 'processor_error' || log.event === 'grid_check_error') type = 'ERROR';

  let message = log.message || log.event || 'telemetry_event';
  if (log.event === 'processor_stage') message = formatStageMessage(log);
  if (log.event === 'profitability_check') message = `Yield checked: ${log.reason} (APR: ${((log.apr || 0) * 100).toFixed(2)}%)`;
  if (log.event === 'force_test_bypass') message = 'Force test bypass enabled, skipping yield checks';
  if (log.event === 'harvest_submitted') message = 'Harvest transaction submitted';
  if (log.event === 'harvest_confirmed') message = 'Harvest transaction confirmed';
  if (log.event === 'hw_address_report') message = `Acurast Hardware Address: ${log.hwAddress}`;
  if (type === 'ERROR') message = `${log.event}: ${log.message ?? 'unknown failure'}`;

  return {
    timestamp: log.timestamp ? log.timestamp * 1000 : Date.now(),
    type,
    message,
    txHash: log.txHash,
  };
}

export function TestingSuite() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { config } = useNetwork();
  const isTestnet = chainId === baseSepolia.id;
  const [logs, setLogs] = useState<HardwareLog[]>([]);
  const [telemetryStatus, setTelemetryStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [telemetryError, setTelemetryError] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintSuccess, setMintSuccess] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  const demoLogs = useMemo<HardwareLog[]>(() => {
    const now = Date.now();
    return [
      {
        timestamp: now - 180_000,
        type: 'ATTESTATION',
        message: 'Demo: yield processor identity reported and lease epoch accepted',
      },
      {
        timestamp: now - 130_000,
        type: 'EXECUTION',
        message: 'Demo: vault APR checked, harvest not submitted because profit is below threshold',
      },
      {
        timestamp: now - 80_000,
        type: 'ATTESTATION',
        message: 'Demo: grid processor authorized against ExecutorRegistry before evaluation',
      },
      {
        timestamp: now - 35_000,
        type: 'STORAGE_SYNC',
        message: 'Demo: active strategy loaded from on-chain status, trade kept as dry run',
      },
    ];
  }, []);

  const { writeContractAsync } = useWriteContract();

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?userAddress=${OPERATOR_ADDRESS}&chainId=${chainId}`);
      if (!res.ok) {
        setTelemetryStatus('error');
        setTelemetryError(`Telemetry API returned ${res.status}`);
        return;
      }

      const data: { logs?: TelemetryLog[] } = await res.json();
      if (Array.isArray(data.logs)) {
        const mapped = data.logs.map(mapTelemetryLog).reverse();
        setLogs(mapped);
        setTelemetryStatus(mapped.length > 0 ? 'ready' : 'empty');
        setTelemetryError('');
      } else {
        setLogs([]);
        setTelemetryStatus('empty');
        setTelemetryError('');
      }
    } catch (error) {
      setTelemetryStatus('error');
      setTelemetryError(error instanceof Error ? error.message : 'Telemetry fetch failed');
    }
  }, [chainId]);

  useEffect(() => {
    const initialFetch = setTimeout(fetchLogs, 0);
    const interval = setInterval(fetchLogs, 5000);
    return () => {
      clearTimeout(initialFetch);
      clearInterval(interval);
    };
  }, [fetchLogs]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const visibleLogs = isDemoMode && logs.length === 0 ? demoLogs : logs;

  const handleMint = async () => {
    if (!isConnected || minting) return;
    setMinting(true);
    setMintSuccess(false);
    try {
      await writeContractAsync({
        address: config.asset,
        abi: MOCK_USDC_ABI,
        functionName: 'mint',
        args: [parseUnits('1000', 6)],
        dataSuffix: BUILDER_CODE_SUFFIX,
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
    <div className="mt-16 flex flex-col gap-8 sm:mt-24 sm:gap-10">
      <div className="flex flex-col gap-4 border-b border-white/[0.05] pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-xl border border-white/10 bg-white/5 p-2.5">
            <TerminalSquare size={18} className="text-[#00FFA3]" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Hardware Debug</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">System Integrity Logs</h3>
          </div>
        </div>
        <div className="flex w-fit items-center gap-2 rounded-xl border border-[#00FFA3]/20 bg-[#00FFA3]/10 px-4 py-1.5 text-[10px] font-mono font-bold text-[#00FFA3] uppercase tracking-widest">
          <Zap size={12} />
          {isTestnet ? 'Sepolia Testnet Active' : 'Base Mainnet Active'}
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-8 sm:gap-10 ${isTestnet ? 'lg:grid-cols-3' : 'lg:grid-cols-1'}`}>
        {isTestnet && (
          <div className="flex flex-col gap-6 lg:col-span-1">
            <div className="ys-card flex flex-col gap-6 bg-[#0B0F0D]/40 p-6 sm:p-8">
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
                  className={`flex w-full items-center justify-between rounded-2xl border p-5 transition-all ${mintSuccess
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
                  className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 p-5 text-[#F5F7FA] transition-all hover:border-[#C2E812]/30 hover:bg-[#C2E812]/5"
                >
                  <div className="flex flex-col items-start">
                    <span className="text-xs font-heading font-bold">Base Sepolia ETH</span>
                    <span className="text-[9px] font-mono text-[#484F58] uppercase">Gas Faucet</span>
                  </div>
                  <ExternalLink size={16} className="text-[#484F58]" />
                </a>
              </div>
            </div>

            <div className="ys-card border-[#C2E812]/10 bg-gradient-to-br from-[#C2E812]/5 to-transparent p-6 sm:p-8">
              <div className="mb-4 flex items-center gap-3">
                <ShieldCheck size={16} className="text-[#C2E812]" />
                <span className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-widest">Verification Status</span>
              </div>
              <p className="text-[11px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
                Connected Acurast Enclave is reporting synchronized state. All decision logic is hardware-attested.
              </p>
            </div>
          </div>
        )}

        <div className={`${isTestnet ? 'lg:col-span-2' : ''} relative min-w-0`}>
          <div className="relative mx-auto aspect-[9/19] min-h-[560px] max-h-[740px] w-full max-w-[430px] overflow-hidden rounded-[3rem] border border-white/10 bg-[#07090A] p-3 shadow-2xl shadow-black/60 md:aspect-[16/7.8] md:min-h-[360px] md:max-h-[620px] md:max-w-none">
            <div className="absolute left-1/2 top-1 h-1 w-24 -translate-x-1/2 rounded-full bg-white/10 md:left-12 md:right-12 md:w-auto md:translate-x-0" />
            <div className="absolute bottom-1 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-white/5 md:left-12 md:right-12 md:w-auto md:translate-x-0" />
            <div className="absolute -left-1 top-36 h-16 w-1 rounded-r bg-white/15 md:top-1/2 md:h-20 md:-translate-y-1/2" />
            <div className="absolute -right-1 top-28 h-14 w-1 rounded-l bg-white/15 md:top-24" />
            <div className="absolute -right-1 top-48 h-14 w-1 rounded-l bg-white/10 md:top-44" />

            <div className="relative flex h-full flex-col overflow-hidden rounded-[2.35rem] border border-white/10 bg-black md:flex-row">
              <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#050708] px-8 md:h-auto md:w-16 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-6">
                <div className="h-2 w-20 rounded-full bg-white/10 md:h-24 md:w-2" />
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#0B0F0D]">
                  <div className="h-4 w-4 rounded-full border border-[#1B2A25] bg-[#030605] shadow-inner shadow-[#00FFA3]/20" />
                </div>
                <div className="h-1.5 w-14 rounded-full bg-white/5 md:h-16 md:w-1.5" />
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-col gap-3 border-b border-white/[0.05] bg-white/[0.025] px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-6">
                  <div className="flex items-center gap-3">
                    <div className="h-2 w-2 rounded-full bg-[#00FFA3] animate-pulse" />
                    <span className="text-[10px] font-mono font-bold text-[#F5F7FA] uppercase tracking-[0.2em]">Live Telemetry Stream</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest md:hidden">Pixel 8 Portrait</span>
                    <span className="hidden text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest md:inline">Pixel 8 Landscape</span>
                    <div className="h-4 w-px bg-white/10" />
                    <span className="text-[9px] font-mono font-bold text-[#8B949E] uppercase tracking-widest">{visibleLogs.length} events</span>
                    <Cpu size={14} className="text-[#484F58]" />
                  </div>
                </div>

                <div
                  ref={scrollContainerRef}
                  className="flex-1 space-y-3 overflow-y-auto p-4 font-mono text-[10px] sm:p-6 sm:text-[11px]"
                >
                  {visibleLogs.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-[#484F58] uppercase tracking-[0.24em]">
                      <span className={telemetryStatus === 'loading' ? 'animate-pulse' : ''}>
                        {telemetryStatus === 'loading'
                          ? 'Initializing secure channel...'
                          : telemetryStatus === 'error'
                            ? 'Telemetry stream unavailable'
                            : 'No processor telemetry received yet'}
                      </span>
                      {telemetryError && (
                        <span className="max-w-sm text-[9px] leading-relaxed text-[#FF4466] tracking-[0.16em]">
                          {telemetryError}
                        </span>
                      )}
                      <button
                        onClick={fetchLogs}
                        className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-[9px] font-bold text-[#8B949E] transition-colors hover:text-[#C2E812]"
                      >
                        Refresh Telemetry
                      </button>
                    </div>
                  ) : (
                    visibleLogs.map((log, i) => (
                      <div
                        key={`${log.timestamp}-${i}`}
                        className="flex flex-col gap-1.5 rounded-xl border border-white/[0.03] bg-white/[0.015] p-3 animate-slide-in-right sm:flex-row sm:items-start sm:gap-3 sm:border-0 sm:bg-transparent sm:p-0"
                        style={{ animationDelay: `${i * 0.05}s` }}
                      >
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-bold text-[#484F58]">
                            {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                          <span className={`shrink-0 rounded px-2 py-0.5 text-[8px] font-bold sm:text-[9px] ${log.type === 'ATTESTATION' ? 'text-[#00FFA3] bg-[#00FFA3]/5' :
                            log.type === 'STORAGE_SYNC' ? 'text-[#C2E812] bg-[#C2E812]/5' :
                              log.type === 'ERROR' ? 'text-[#FF4466] bg-[#FF4466]/10' :
                                'text-[#00d4ff] bg-[#00d4ff]/5'
                            }`}>
                            [{log.type}]
                          </span>
                        </div>
                        <span className="min-w-0 break-words text-[#F5F7FA] leading-relaxed opacity-90">
                          {log.message}
                          {log.txHash && (
                            <a
                              href={`${config.explorer}/tx/${log.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-2 whitespace-nowrap text-[#C2E812] hover:underline"
                            >
                              VIEW RECEIPT
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
