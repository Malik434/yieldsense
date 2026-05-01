'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import { parseUnits } from 'viem';
import { Terminal, Droplets, ArrowRight, CheckCircle2, ShieldCheck, Loader2 } from 'lucide-react';
import { MOCK_USDC_ABI, ASSET_ADDRESS } from '@/lib/contracts';

interface HardwareLog {
  timestamp: number;
  type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC';
  message: string;
  txHash?: string;
}

export function TestingSuite() {
  const { isConnected } = useAccount();
  const [logs, setLogs] = useState<HardwareLog[]>([]);
  const [minting, setMinting] = useState(false);
  const [mintSuccess, setMintSuccess] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { writeContractAsync } = useWriteContract();

  // Poll state endpoint for hardware logs
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch('/api/state');
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
            // Logs are returned newest-first from ring buffer, reverse for chronological terminal view
            setLogs(mappedLogs.reverse());
          }
        }
      } catch { }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
        gas: BigInt(200000),
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
    <div className="flex flex-col gap-6">
      {/* Testnet Faucet */}
      <div className="cyber-card p-6 flex flex-col gap-4">
        <div className="flex items-center gap-2 mb-2">
          <Droplets size={16} style={{ color: '#00d4ff' }} />
          <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#00d4ff', letterSpacing: '0.15em' }}>
            TESTNET FAUCET
          </span>
        </div>

        <p className="font-mono text-xs" style={{ color: '#94a3b8', lineHeight: 1.6 }}>
          You need Base Sepolia ETH for gas and Mock USDC to deposit into the YieldSense vault.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          {/* Base Sepolia ETH */}
          <div className="rounded-lg p-4 flex flex-col justify-between gap-4" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              <span className="font-mono text-xs font-semibold" style={{ color: '#e2e8f0' }}>Base Sepolia ETH</span>
              <p className="font-mono text-[10px] mt-1" style={{ color: '#64748b' }}>Required for transaction gas fees.</p>
            </div>
            <a
              href="https://portal.cdp.coinbase.com/products/faucet"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3 py-2 rounded-lg font-mono text-[10px] transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#00d4ff'; (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0,212,255,0.06)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#94a3b8'; (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.05)'; }}
            >
              COINBASE FAUCET <ArrowRight size={12} />
            </a>
          </div>

          {/* Mock USDC */}
          <div className="rounded-lg p-4 flex flex-col justify-between gap-4" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              <span className="font-mono text-xs font-semibold" style={{ color: '#e2e8f0' }}>Mock USDC</span>
              <p className="font-mono text-[10px] mt-1" style={{ color: '#64748b' }}>Testnet asset for the YieldSense vault.</p>
            </div>
            <button
              onClick={handleMint}
              disabled={!isConnected || minting}
              className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg font-mono text-[10px] font-bold transition-all"
              style={{
                background: mintSuccess ? 'rgba(0,255,159,0.1)' : 'rgba(0,212,255,0.1)',
                border: `1px solid ${mintSuccess ? 'rgba(0,255,159,0.3)' : 'rgba(0,212,255,0.3)'}`,
                color: mintSuccess ? '#00ff9f' : '#00d4ff',
                cursor: (!isConnected || minting) ? 'not-allowed' : 'pointer',
                opacity: (!isConnected || minting) && !mintSuccess ? 0.5 : 1
              }}
            >
              {minting ? <><Loader2 size={12} className="animate-spin" /> MINTING...</> :
                mintSuccess ? <><CheckCircle2 size={12} /> 1000 USDC MINTED</> :
                  'MINT 1000 MOCK USDC'}
            </button>
          </div>
        </div>
      </div>

      {/* Hardware Proof Log */}
      <div className="cyber-card flex flex-col overflow-hidden h-[300px]">
        <div className="flex items-center justify-between p-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
          <div className="flex items-center gap-2">
            <Terminal size={14} style={{ color: '#00ff9f' }} />
            <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#00ff9f', letterSpacing: '0.15em' }}>
              HARDWARE PROOF LOGS
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded" style={{ background: 'rgba(0,255,159,0.08)', border: '1px solid rgba(0,255,159,0.2)' }}>
            <ShieldCheck size={10} style={{ color: '#00ff9f' }} />
            <span className="font-mono text-[9px]" style={{ color: '#00ff9f' }}>TEE CONNECTED</span>
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto font-mono text-[10px]" style={{ background: '#05070a' }}>
          {logs.length === 0 ? (
            <p style={{ color: '#475569' }}>Waiting for Acurast Processor telemetry...</p>
          ) : (
            <div className="flex flex-col gap-2">
              {logs.map((log, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(log.timestamp).toISOString().split('T')[1].replace('Z', '')}
                  </span>
                  <span style={{
                    color: log.type === 'EXECUTION' ? '#00d4ff' : log.type === 'STORAGE_SYNC' ? '#a78bfa' : '#00ff9f',
                    minWidth: '80px'
                  }}>
                    [{log.type}]
                  </span>
                  <span style={{ color: '#e2e8f0', wordBreak: 'break-all' }}>
                    {log.message}
                    {log.txHash && (
                      <a
                        href={`https://base-sepolia.blockscout.com/tx/${log.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#00d4ff', marginLeft: 8, textDecoration: 'underline' }}
                      >
                        view tx ↗
                      </a>
                    )}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
