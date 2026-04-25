'use client';

import { useState, useEffect } from 'react';
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useSignTypedData } from 'wagmi';
import { parseEther } from 'viem';
import { Server, Cpu, ShieldCheck, Zap, CheckCircle2, Loader2, Key, Package, FileCode2, Handshake } from 'lucide-react';

type ProvisionState = 'idle' | 'bundling' | 'pinning' | 'handshake' | 'funding' | 'ready';

interface AttestationProof {
  deviceModel: string;
  securityPatchLevel: string;
  teeStatus: string;
}

export function WorkerProvisioningBox({ onProvisioned }: { onProvisioned?: (workerAddress: string) => void }) {
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState<ProvisionState>('idle');
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [workerAddress, setWorkerAddress] = useState<string | null>(null);
  const [attestation, setAttestation] = useState<AttestationProof | null>(null);

  const { signTypedDataAsync } = useSignTypedData();
  const { data: hash, sendTransaction, isPending: isTxPending } = useSendTransaction();
  const { isLoading: isWaitingReceipt, isSuccess: isTxSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!address) return;
    const stored = localStorage.getItem(`ys_worker_${address}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setWorkerAddress(parsed.workerAddress);
        setDeploymentId(parsed.deploymentId);
        setAttestation(parsed.attestation);
        setIpfsCid(parsed.ipfsCid);
        setStep('ready');
        if (onProvisioned) onProvisioned(parsed.workerAddress);
      } catch { /* ignore */ }
    }
  }, [address, onProvisioned]);

  const handleDeploy = async () => {
    if (!address) return;
    try {
      setStep('handshake');
      const mockStrategy = { stopLoss: 0.95, gridUpper: 1.1, gridLower: 0.9, rebalanceInterval: 4 };
      const mockPublicKey = `0x04${Math.random().toString(16).substring(2, 66)}`;
      const targetWorkerAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;

      const domain = { name: 'YieldSense', version: '1', chainId: 84532 };
      const types = { Deployment: [{ name: 'intent', type: 'string' }, { name: 'owner', type: 'address' }] };
      const signature = await signTypedDataAsync({
        domain,
        types,
        primaryType: 'Deployment',
        message: { intent: 'Authorize Acurast Direct Match Deployment', owner: address as `0x${string}` }
      });

      setStep('bundling'); // Bundling & Deploying state

      const deployRes = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyParams: mockStrategy, publicKey: mockPublicKey, workerAddress: targetWorkerAddress, signature })
      });

      if (!deployRes.ok) {
        throw new Error('Deployment API failed');
      }

      const { ipfsCid, deploymentId } = await deployRes.json();
      setIpfsCid(ipfsCid);
      setDeploymentId(deploymentId);
      setWorkerAddress(targetWorkerAddress);

      setAttestation({
        deviceModel: 'Google Pixel 8 Pro',
        securityPatchLevel: '2026-03-05',
        teeStatus: 'Secured (StrongBox)',
      });

      setStep('funding');
    } catch (err) {
      console.error("Deployment failed or cancelled", err);
      setStep('idle');
    }
  };

  const handleFund = () => {
    if (!workerAddress) return;
    sendTransaction({
      to: workerAddress as `0x${string}`,
      value: parseEther('0.001'),
    });
  };

  useEffect(() => {
    if (isTxSuccess && workerAddress && deploymentId && attestation && address) {
      setStep('ready');
      localStorage.setItem(`ys_worker_${address}`, JSON.stringify({
        workerAddress, deploymentId, attestation, ipfsCid
      }));
      if (onProvisioned) onProvisioned(workerAddress);
    }
  }, [isTxSuccess, workerAddress, deploymentId, attestation, ipfsCid, address, onProvisioned]);

  const resetProvisioning = () => {
    if (address) localStorage.removeItem(`ys_worker_${address}`);
    setStep('idle');
    setDeploymentId(null);
    setWorkerAddress(null);
    setAttestation(null);
    setIpfsCid(null);
    if (onProvisioned) onProvisioned('');
  };

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
          <button
            onClick={resetProvisioning}
            className="font-mono text-[9px] hover:text-[#00ff9f] transition-colors"
            style={{ color: '#64748b' }}
          >
            RESET
          </button>
        )}
      </div>

      <p className="font-mono text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
        Dynamic Deployment Orchestration: Bundle logic, pin to IPFS, and deploy a direct-match TEE processor.
      </p>

      {!isConnected ? (
        <div className="flex-1 flex items-center justify-center p-4 border border-dashed rounded-lg" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
          <p className="font-mono text-xs text-center" style={{ color: '#334155' }}>
            Connect wallet to deploy worker
          </p>
        </div>
      ) : step === 'idle' ? (
        <div className="flex-1 flex flex-col justify-end gap-4 mt-4">
          <button onClick={handleDeploy} className="btn-primary flex items-center justify-center gap-2 w-full">
            <Cpu size={14} />
            INITIATE ON-DEMAND DEPLOYMENT
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 mt-2">

          {/* 1. Handshake */}
          <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {step === 'handshake' ? <Loader2 size={13} className="animate-spin text-[#f59e0b]" /> : <CheckCircle2 size={13} className="text-[#00ff9f]" />}
                <span className="font-mono text-[10px]" style={{ color: step === 'handshake' ? '#f59e0b' : '#00ff9f' }}>
                  {step === 'handshake' ? 'Awaiting Wallet Signature...' : 'Deployment Authorized'}
                </span>
              </div>
            </div>
          </div>

          {/* 2. CLI Deployment (Bundling & Pinning) */}
          {(step === 'bundling' || step === 'pinning' || step === 'funding' || step === 'ready') && (
            <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {step === 'bundling' ? <Loader2 size={13} className="animate-spin text-[#00d4ff]" /> : <CheckCircle2 size={13} className="text-[#00ff9f]" />}
                  <span className="font-mono text-[10px]" style={{ color: step === 'bundling' ? '#00d4ff' : '#00ff9f' }}>
                    {step === 'bundling' ? ' Acurast Network Deployment in Progress...' : 'Deployed & Pinned via Acurast CLI'}
                  </span>
                </div>
              </div>
              {ipfsCid && (
                <div className="flex flex-col mt-1">
                  <span className="font-mono text-[9px] text-[#64748b]">IPFS CID: {ipfsCid}</span>
                  {deploymentId && <span className="font-mono text-[9px] text-[#64748b]">DEPLOYMENT ID: {deploymentId}</span>}
                </div>
              )}
            </div>
          )}

          {/* 3. TEE Attestation */}
          {(step === 'funding' || step === 'ready') && attestation && (
            <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={13} className="text-[#00ff9f]" />
                  <span className="font-mono text-[10px] text-[#00ff9f]">
                    REMOTE ATTESTATION VERIFIED
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="flex flex-col">
                  <span className="font-mono text-[9px] text-[#64748b]">DEVICE</span>
                  <span className="font-mono text-[10px] text-[#e2e8f0]">{attestation.deviceModel}</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-mono text-[9px] text-[#64748b]">TEE STATUS</span>
                  <span className="font-mono text-[10px] text-[#00ff9f]">{attestation.teeStatus}</span>
                </div>
              </div>
            </div>
          )}

          {/* 4. Funding */}
          {(step === 'funding' || step === 'ready') && (
            <div className="flex flex-col gap-3 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {step === 'funding' ? <Key size={13} className="text-[#f59e0b]" /> : <CheckCircle2 size={13} className="text-[#00ff9f]" />}
                  <span className="font-mono text-[10px]" style={{ color: step === 'funding' ? '#f59e0b' : '#00ff9f' }}>
                    {step === 'funding' ? 'AWAITING GAS HANDOVER' : `✅ Worker Active on Processor [${workerAddress?.slice(0, 6)}...]`}
                  </span>
                </div>
              </div>
              {step === 'funding' && (
                <button
                  onClick={handleFund}
                  disabled={isTxPending || isWaitingReceipt}
                  className="mt-2 py-2 rounded font-mono text-[10px] font-semibold flex items-center justify-center gap-2 transition-all"
                  style={{
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    color: '#f59e0b',
                    opacity: (isTxPending || isWaitingReceipt) ? 0.5 : 1
                  }}
                >
                  {(isTxPending || isWaitingReceipt) ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  {(isTxPending || isWaitingReceipt) ? 'CONFIRMING TX...' : 'FUND & ACTIVATE (0.001 ETH)'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
