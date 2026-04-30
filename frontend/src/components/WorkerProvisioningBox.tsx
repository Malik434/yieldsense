'use client';

import { useState, useEffect } from 'react';
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useWriteContract, useSignTypedData, useChainId } from 'wagmi';
import { parseEther, isAddress } from 'viem';
import { Server, Cpu, Zap, CheckCircle2, Loader2, AlertTriangle, Link } from 'lucide-react';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';

/**
 * Provisioning flow (no fake steps):
 *  1. User enters their Acurast processor address manually
 *  2. Frontend calls /api/deploy → bundles processor.ts → pins to IPFS
 *  3. User sends 0.001 ETH to the processor address for gas
 *  4. After ETH confirms, user calls assignProcessor(processorAddress) on-chain
 *  5. Ready — executeTrade will now accept signatures from this processor
 *
 * NOTE: Processor discovery from the Acurast Hub is not yet integrated.
 * Users must obtain their processor's Ethereum address from the Acurast dashboard
 * after provisioning a Cargo job.
 */

type ProvisionState =
  | 'idle'
  | 'bundling'
  | 'funding'
  | 'waiting_fund'
  | 'assigning'
  | 'waiting_assign'
  | 'ready';

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
  const [inputError, setInputError] = useState<string | null>(null);
  const [processorAddress, setProcessorAddress] = useState<string | null>(null);
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const { signTypedDataAsync } = useSignTypedData();

  const {
    data: fundHash,
    sendTransaction,
    isPending: isFundPending,
  } = useSendTransaction();

  const { isLoading: isWaitingFund, isSuccess: isFundSuccess } = useWaitForTransactionReceipt({
    hash: fundHash,
  });

  const { writeContractAsync, isPending: isAssignPending } = useWriteContract();

  // Restore persisted provisioning state for this wallet
  useEffect(() => {
    if (!address) return;
    const stored = localStorage.getItem(`ys_worker_${address}`);
    if (!stored) return;
    try {
      const parsed: ProvisionedData = JSON.parse(stored);
      if (parsed.processorAddress && parsed.ipfsCid) {
        setProcessorAddress(parsed.processorAddress);
        setIpfsCid(parsed.ipfsCid);
        setDeploymentId(parsed.deploymentId);
        setStep('ready');
        onProvisioned?.(parsed.processorAddress);
      }
    } catch {
      /* ignore corrupt cache */
    }
  }, [address, onProvisioned]);

  // After ETH funding confirms, move to assign step
  useEffect(() => {
    if (isFundSuccess && step === 'waiting_fund') {
      setStep('assigning');
    }
  }, [isFundSuccess, step]);

  const validateAndSetProcessor = () => {
    const trimmed = processorInput.trim();
    if (!isAddress(trimmed)) {
      setInputError('Invalid Ethereum address. Must be 0x + 40 hex characters.');
      return false;
    }
    setInputError(null);
    setProcessorAddress(trimmed);
    return trimmed;
  };

  const handleDeploy = async () => {
    const addr = validateAndSetProcessor();
    if (!addr || !address) return;

    setDeployError(null);
    setStep('bundling');

    try {
      // Sign the deploy request so /api/deploy can verify the caller owns ownerAddress
      const timestamp = Date.now();
      const deployDomain = { name: 'YieldSense', version: '1', chainId } as const;
      const deployTypes = {
        DeployRequest: [
          { name: 'ownerAddress', type: 'address' },
          { name: 'workerAddress', type: 'address' },
          { name: 'timestamp', type: 'uint256' },
        ],
      } as const;
      const deploySig = await signTypedDataAsync({
        domain: deployDomain,
        types: deployTypes,
        primaryType: 'DeployRequest',
        message: {
          ownerAddress: address as `0x${string}`,
          workerAddress: addr as `0x${string}`,
          timestamp: BigInt(timestamp),
        },
      });

      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerAddress: address,
          workerAddress: addr,
          strategyParams: {},
          signature: deploySig,
          timestamp,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Deploy API returned ${res.status}`);
      }

      const { ipfsCid: cid, deploymentId: dId } = await res.json();
      setIpfsCid(cid);
      setDeploymentId(dId);
      setStep('funding');
    } catch (err: any) {
      setDeployError(err.message ?? 'Bundle/upload failed');
      setStep('idle');
    }
  };

  const handleFund = () => {
    if (!processorAddress) return;
    sendTransaction({
      to: processorAddress as `0x${string}`,
      value: parseEther('0.001'),
    });
    setStep('waiting_fund');
  };

  const handleAssign = async () => {
    if (!processorAddress) return;
    setStep('assigning');
    try {
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'assignProcessor',
        args: [processorAddress as `0x${string}`],
      });

      setStep('ready');
      if (address) {
        const data: ProvisionedData = {
          processorAddress,
          ipfsCid: ipfsCid ?? '',
          deploymentId: deploymentId ?? '',
        };
        localStorage.setItem(`ys_worker_${address}`, JSON.stringify(data));
      }
      onProvisioned?.(processorAddress);
    } catch (err: any) {
      // Common revert: ProcessorNotAttested — processor hasn't been attested by admin yet
      const msg: string = err?.shortMessage ?? err?.message ?? String(err);
      const isNotAttested =
        msg.includes('ProcessorNotAttested') || msg.includes('0x') ;
      setDeployError(
        isNotAttested
          ? 'Processor not yet attested by protocol admin. Contact the YieldSense team to attest your processor address before assigning.'
          : `assignProcessor failed: ${msg}`
      );
      setStep('funding');
    }
  };

  const reset = () => {
    if (address) localStorage.removeItem(`ys_worker_${address}`);
    setStep('idle');
    setProcessorAddress(null);
    setProcessorInput('');
    setIpfsCid(null);
    setDeploymentId(null);
    setDeployError(null);
    setInputError(null);
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={16} style={{ color: '#00d4ff' }} />
          <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#00d4ff', letterSpacing: '0.15em' }}>
            WORKER PROVISIONING
          </span>
        </div>
        {step === 'ready' && (
          <button
            onClick={reset}
            className="font-mono text-[9px] hover:text-[#00ff9f] transition-colors"
            style={{ color: '#64748b' }}
          >
            RESET
          </button>
        )}
      </div>

      {/* Discovery notice — honest about current integration state */}
      <div
        className="flex items-start gap-2 rounded-lg p-3"
        style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.15)' }}
      >
        <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#78716c' }}>
          Live Acurast worker discovery is not yet integrated. Enter your processor&apos;s
          Ethereum address below — obtain it from the Acurast Dashboard after deploying a Cargo job.
          The protocol admin must attest your processor address before you can assign it.
        </p>
      </div>

      {/* ── STEP 1: idle — address input ── */}
      {step === 'idle' && (
        <div className="flex flex-col gap-3">
          <label className="font-mono text-[10px]" style={{ color: '#64748b' }}>
            ACURAST PROCESSOR ADDRESS
          </label>
          <input
            type="text"
            placeholder="0x..."
            value={processorInput}
            onChange={(e) => { setProcessorInput(e.target.value); setInputError(null); }}
            className="cyber-input w-full font-mono text-xs"
            spellCheck={false}
          />
          {inputError && (
            <p className="font-mono text-[10px]" style={{ color: '#ff4466' }}>{inputError}</p>
          )}
          {deployError && (
            <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#ff4466' }}>{deployError}</p>
          )}
          <button
            onClick={handleDeploy}
            disabled={!processorInput}
            className="btn-primary flex items-center justify-center gap-2 w-full"
            style={{ opacity: processorInput ? 1 : 0.4 }}
          >
            <Cpu size={14} />
            BUNDLE & DEPLOY STRATEGY
          </button>
        </div>
      )}

      {/* ── STEP 2: bundling ── */}
      {step === 'bundling' && (
        <div className="flex flex-col items-center justify-center gap-3 py-6 border border-dashed rounded-lg"
          style={{ borderColor: 'rgba(0,212,255,0.3)', background: 'rgba(0,212,255,0.04)' }}>
          <Loader2 size={22} className="animate-spin text-[#00d4ff]" />
          <p className="font-mono text-xs text-[#00d4ff]">Bundling processor logic and pinning to IPFS…</p>
        </div>
      )}

      {/* ── STEP 3+: progress checklist ── */}
      {(step === 'funding' || step === 'waiting_fund' || step === 'assigning' || step === 'waiting_assign' || step === 'ready') && (
        <div className="flex flex-col gap-3">

          {/* Bundle complete */}
          <StepRow
            done
            label={`Logic bundled & pinned${ipfsCid ? ` — CID: ${ipfsCid.slice(0, 16)}…` : ''}`}
          />

          {/* Fund step */}
          <StepRow
            done={step === 'assigning' || step === 'waiting_assign' || step === 'ready'}
            active={step === 'funding' || step === 'waiting_fund'}
            label={
              step === 'waiting_fund'
                ? 'Confirming ETH transfer…'
                : step === 'funding'
                ? 'Fund processor with gas (0.001 ETH)'
                : 'Processor funded'
            }
          >
            {step === 'funding' && (
              <button
                onClick={handleFund}
                disabled={isFundPending || isWaitingFund}
                className="mt-2 py-2 px-4 rounded font-mono text-[10px] font-semibold flex items-center gap-2 transition-all"
                style={{
                  background: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  color: '#f59e0b',
                  opacity: isFundPending || isWaitingFund ? 0.5 : 1,
                }}
              >
                {isFundPending || isWaitingFund
                  ? <><Loader2 size={11} className="animate-spin" /> CONFIRMING…</>
                  : <><Zap size={11} /> SEND 0.001 ETH</>}
              </button>
            )}
          </StepRow>

          {/* Assign step */}
          <StepRow
            done={step === 'ready'}
            active={step === 'assigning'}
            label={
              step === 'assigning'
                ? 'Assigning processor on-chain…'
                : step === 'ready'
                ? `Processor assigned — ${processorAddress?.slice(0, 10)}…`
                : 'Bind processor to your account'
            }
          >
            {step === 'assigning' && !isAssignPending && (
              <button
                onClick={handleAssign}
                className="mt-2 py-2 px-4 rounded font-mono text-[10px] font-semibold flex items-center gap-2 transition-all"
                style={{
                  background: 'rgba(0,212,255,0.08)',
                  border: '1px solid rgba(0,212,255,0.3)',
                  color: '#00d4ff',
                }}
              >
                <Link size={11} />
                ASSIGN PROCESSOR ON-CHAIN
              </button>
            )}
            {step === 'assigning' && isAssignPending && (
              <div className="mt-2 flex items-center gap-2">
                <Loader2 size={11} className="animate-spin text-[#00d4ff]" />
                <span className="font-mono text-[10px] text-[#00d4ff]">Waiting for wallet confirmation…</span>
              </div>
            )}
          </StepRow>

          {deployError && (
            <p className="font-mono text-[10px] leading-relaxed rounded p-2"
              style={{ color: '#ff4466', background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.2)' }}>
              {deployError}
            </p>
          )}

          {step === 'ready' && (
            <div
              className="flex items-center gap-2 mt-1 p-3 rounded-lg"
              style={{ background: 'rgba(0,255,159,0.05)', border: '1px solid rgba(0,255,159,0.2)' }}
            >
              <CheckCircle2 size={14} className="text-[#00ff9f]" />
              <span className="font-mono text-xs text-[#00ff9f]">
                Worker active. Processor will execute trades for your account.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({
  done,
  active,
  label,
  children,
}: {
  done?: boolean;
  active?: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1 p-3 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="flex items-center gap-2">
        {done
          ? <CheckCircle2 size={12} className="text-[#00ff9f]" />
          : active
          ? <Loader2 size={12} className="animate-spin text-[#00d4ff]" />
          : <div className="w-3 h-3 rounded-full" style={{ border: '1px solid #334155' }} />}
        <span
          className="font-mono text-[10px]"
          style={{ color: done ? '#00ff9f' : active ? '#00d4ff' : '#475569' }}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}
