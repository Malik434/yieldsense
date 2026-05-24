'use client';

import { useEffect, useState } from 'react';
import { useAccount, useChainId, useSendTransaction, useSignTypedData, useWaitForTransactionReceipt } from 'wagmi';
import { isAddress, parseEther } from 'viem';
import { AlertTriangle, CheckCircle2, Cpu, Loader2, Server, Zap } from 'lucide-react';
import { BUILDER_CODE_SUFFIX } from '@/lib/contracts';

type ProvisionState = 'idle' | 'bundling' | 'funding' | 'waiting_fund' | 'ready';

interface ProvisionedData {
  processorAddress: string;
  ipfsCid: string;
  deploymentId: string;
}

export function WorkerProvisioningBox({ onProvisioned }: { onProvisioned?: (workerAddress: string) => void }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [step, setStep] = useState<ProvisionState>('idle');
  const [processorInput, setProcessorInput] = useState('');
  const [processorAddress, setProcessorAddress] = useState<string | null>(null);
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { signTypedDataAsync } = useSignTypedData();
  const { data: fundHash, sendTransaction, isPending: isFundPending } = useSendTransaction();
  const { isSuccess: isFundSuccess, isLoading: isWaitingFund } = useWaitForTransactionReceipt({ hash: fundHash });

  useEffect(() => {
    if (!address) return;
    const stored = localStorage.getItem(`ys_worker_${address}_${chainId}`);
    if (!stored) return;
    try {
      const parsed: ProvisionedData = JSON.parse(stored);
      if (parsed.processorAddress) {
        setProcessorAddress(parsed.processorAddress);
        setIpfsCid(parsed.ipfsCid);
        setDeploymentId(parsed.deploymentId);
        setStep('ready');
        onProvisioned?.(parsed.processorAddress);
      }
    } catch {}
  }, [address, chainId, onProvisioned]);

  useEffect(() => {
    if (isFundSuccess && step === 'waiting_fund') {
      persistReady();
    }
  }, [isFundSuccess, step]);

  const persistReady = () => {
    if (!address || !processorAddress) return;
    const data: ProvisionedData = {
      processorAddress,
      ipfsCid: ipfsCid ?? '',
      deploymentId: deploymentId ?? '',
    };
    localStorage.setItem(`ys_worker_${address}_${chainId}`, JSON.stringify(data));
    setStep('ready');
    onProvisioned?.(processorAddress);
  };

  const handleDeploy = async () => {
    const workerAddress = processorInput.trim();
    if (!address || !isAddress(workerAddress)) {
      setError('Invalid Ethereum address.');
      return;
    }

    setError(null);
    setProcessorAddress(workerAddress);
    setStep('bundling');

    try {
      const timestamp = Date.now();
      const signature = await signTypedDataAsync({
        domain: { name: 'YieldSense', version: '1', chainId },
        types: {
          DeployRequest: [
            { name: 'ownerAddress', type: 'address' },
            { name: 'workerAddress', type: 'address' },
            { name: 'timestamp', type: 'uint256' },
          ],
        },
        primaryType: 'DeployRequest',
        message: {
          ownerAddress: address,
          workerAddress,
          timestamp: BigInt(timestamp),
        },
      });

      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerAddress: address,
          workerAddress,
          strategyParams: {},
          signature,
          timestamp,
          chainId,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Deploy API returned ${response.status}`);
      }

      const body = await response.json();
      setIpfsCid(body.ipfsCid ?? '');
      setDeploymentId(body.deploymentId ?? '');
      setStep('funding');
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setStep('idle');
    }
  };

  const handleFund = () => {
    if (!processorAddress) return;
    sendTransaction({
      to: processorAddress as `0x${string}`,
      value: parseEther('0.001'),
      dataSuffix: BUILDER_CODE_SUFFIX,
    });
    setStep('waiting_fund');
  };

  const reset = () => {
    if (address) localStorage.removeItem(`ys_worker_${address}_${chainId}`);
    setStep('idle');
    setProcessorInput('');
    setProcessorAddress(null);
    setIpfsCid(null);
    setDeploymentId(null);
    setError(null);
    onProvisioned?.('');
  };

  if (!isConnected) {
    return (
      <div className="cyber-card p-6 flex items-center justify-center min-h-[220px]">
        <p className="font-mono text-xs text-center" style={{ color: '#334155' }}>
          Connect wallet to provision a worker
        </p>
      </div>
    );
  }

  return (
    <div className="cyber-card p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={16} style={{ color: '#00d4ff' }} />
          <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#00d4ff', letterSpacing: '0.15em' }}>
            WORKER PROVISIONING
          </span>
        </div>
        {step === 'ready' && (
          <button onClick={reset} className="font-mono text-[9px] hover:text-[#00ff9f] transition-colors" style={{ color: '#64748b' }}>
            RESET
          </button>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg p-3" style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.15)' }}>
        <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#78716c' }}>
          Processor execution is now authorized by ExecutorRegistry. After deploying a Yield or Grid Acurast job,
          the testing owner must register its address with the correct role. Users no longer bind vault access to a processor.
        </p>
      </div>

      {step === 'idle' && (
        <div className="flex flex-col gap-3">
          <label className="font-mono text-[10px]" style={{ color: '#64748b' }}>
            ACURAST PROCESSOR ADDRESS
          </label>
          <input
            type="text"
            placeholder="0x..."
            value={processorInput}
            onChange={(event) => setProcessorInput(event.target.value)}
            className="cyber-input w-full font-mono text-xs"
            spellCheck={false}
          />
          {error && <p className="font-mono text-[10px]" style={{ color: '#ff4466' }}>{error}</p>}
          <button
            onClick={handleDeploy}
            disabled={!processorInput}
            className="btn-primary flex items-center justify-center gap-2 w-full"
            style={{ opacity: processorInput ? 1 : 0.4 }}
          >
            <Cpu size={14} />
            BUNDLE PROCESSOR
          </button>
        </div>
      )}

      {step === 'bundling' && (
        <div className="flex flex-col items-center justify-center gap-3 py-6 border border-dashed rounded-lg" style={{ borderColor: 'rgba(0,212,255,0.3)', background: 'rgba(0,212,255,0.04)' }}>
          <Loader2 size={22} className="animate-spin text-[#00d4ff]" />
          <p className="font-mono text-xs text-[#00d4ff]">Bundling processor logic...</p>
        </div>
      )}

      {(step === 'funding' || step === 'waiting_fund' || step === 'ready') && (
        <div className="flex flex-col gap-3">
          <StepRow done label={`Logic bundled${ipfsCid ? ` - CID: ${ipfsCid}` : ''}`} />
          <StepRow done={step === 'ready'} active={step === 'funding' || step === 'waiting_fund'} label={step === 'ready' ? 'Processor funded' : 'Fund processor with gas'}>
            {step === 'funding' && (
              <button onClick={handleFund} disabled={isFundPending || isWaitingFund} className="mt-2 py-2 px-4 rounded font-mono text-[10px] font-semibold flex items-center gap-2 transition-all" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>
                {isFundPending || isWaitingFund ? <><Loader2 size={11} className="animate-spin" /> CONFIRMING...</> : <><Zap size={11} /> SEND 0.001 ETH</>}
              </button>
            )}
          </StepRow>
          <StepRow done={step === 'ready'} label="Register processor role through ExecutorRegistry" />
          {step === 'ready' && (
            <div className="flex items-center gap-2 mt-1 p-3 rounded-lg" style={{ background: 'rgba(0,255,159,0.05)', border: '1px solid rgba(0,255,159,0.2)' }}>
              <CheckCircle2 size={14} className="text-[#00ff9f]" />
              <span className="font-mono text-xs text-[#00ff9f]">
                Worker details saved locally. Register the processor role before live execution.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ done, active, label, children }: { done?: boolean; active?: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2">
        {done ? <CheckCircle2 size={12} className="text-[#00ff9f]" /> : active ? <Loader2 size={12} className="animate-spin text-[#00d4ff]" /> : <div className="w-3 h-3 rounded-full" style={{ border: '1px solid #334155' }} />}
        <span className="font-mono text-[10px]" style={{ color: done ? '#00ff9f' : active ? '#00d4ff' : '#475569' }}>
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}
