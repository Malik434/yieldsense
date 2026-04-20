'use client';

import { useState, useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { formatUnits, parseUnits, maxUint256 } from 'viem';
import Link from 'next/link';
import { ASSET_ADDRESS, KEEPER_ADDRESS, ERC20_ABI, KEEPER_ABI } from '@/lib/contracts';

export default function VaultPage() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  const [depositAmount, setDepositAmount] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Use the ASSET_ADDRESS from .env.local if available, otherwise fetch dynamically
  const { data: dynamicAssetAddress } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'asset',
  });
  const actualAssetAddress = ASSET_ADDRESS || (dynamicAssetAddress as `0x${string}`);

  // Read Allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, KEEPER_ADDRESS] : undefined,
    query: { enabled: !!address && !!actualAssetAddress }
  });

  // Read User Balance (Asset)
  const { data: assetBalance, refetch: refetchBalance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!actualAssetAddress }
  });

  // Read Active Vault Liquidity (Keeper)
  const { data: userData, refetch: refetchUserData } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'userData',
    args: address ? [address] : undefined,
    query: { enabled: !!address }
  });

  const { writeContractAsync } = useWriteContract();

  const handleApprove = async () => {
    try {
      await writeContractAsync({
        address: actualAssetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [KEEPER_ADDRESS, maxUint256],
        gas: BigInt(100000), // Hardcoded to bypass RPC estimation bug
      });
      refetchAllowance();
    } catch (e) {
      console.error(e);
    }
  };

  const handleRevoke = async () => {
    try {
      await writeContractAsync({
        address: actualAssetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [KEEPER_ADDRESS, BigInt(0)],
        gas: BigInt(100000),
      });
      refetchAllowance();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeposit = async () => {
    if (!depositAmount) return;
    try {
      const amount = parseUnits(depositAmount, 18); // assuming 18 decimals for USDC/Asset
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'deposit',
        args: [amount],
        gas: BigInt(300000),
      });
      refetchUserData();
      refetchBalance();
    } catch (e) {
      console.error(e);
    }
  };

  const handleWithdraw = async () => {
    try {
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'withdraw',
        gas: BigInt(300000),
      });
      refetchUserData();
      refetchBalance();
    } catch (e) {
      console.error(e);
    }
  };

  const isApproved = allowance && allowance > BigInt(0);
  const balanceVal = userData ? (userData as any)[0] : BigInt(0);
  const initialDepositVal = userData ? (userData as any)[1] : BigInt(0);

  if (!mounted) return null;

  return (
    <main className="container">
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <Link href="/" style={{ textDecoration: 'none', background: 'var(--surface-hover)', padding: '8px 16px', borderRadius: '8px', color: 'var(--text-primary)', border: '1px solid var(--border)', fontSize: '0.9rem' }}>
            ← Back to Dashboard
          </Link>
          <h1 style={{ margin: 0 }}>YieldSense Vault</h1>
        </div>
        {!isConnected ? (
          <button
            className="status-indicator"
            style={{ cursor: 'pointer', background: 'var(--primary)', color: '#fff', border: 'none', fontWeight: 'bold' }}
            onClick={() => connect({ connector: injected() })}
          >
            Connect MetaMask
          </button>
        ) : (
          <button
            className="status-indicator"
            style={{ cursor: 'pointer', background: 'var(--success)', color: '#fff', border: 'none', fontWeight: 'bold' }}
            onClick={() => disconnect()}
          >
            <span className="dot" style={{ background: '#fff' }}></span>
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </button>
        )}
      </header>

      {!isConnected ? (
        <div className="card text-center mt-8 p-6" style={{ textAlign: 'center' }}>
          <h2>Connect Your Wallet</h2>
          <p className="text-secondary mt-4">Connect your Web3 wallet to manage your liquidity in the YieldSense Auto-Harvester.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2">
          {/* Liquidity Management Card */}
          <div className="card">
            <h2 className="card-title">Manage Liquidity</h2>

            <div className="mt-4 mb-4">
              <span className="text-secondary">Wallet Asset Balance: </span>
              <strong>{assetBalance ? formatUnits(assetBalance as bigint, 18) : '0'}</strong>
            </div>

            {!isApproved ? (
              <div className="p-6" style={{ background: 'var(--surface-hover)', borderRadius: '8px', textAlign: 'center' }}>
                <p className="mb-4">You need to grant the YieldSense Keeper access to your assets.</p>
                <button
                  onClick={handleApprove}
                  style={{ background: 'var(--primary)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer' }}
                >
                  Grant Access
                </button>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                  <input
                    type="number"
                    placeholder="Amount to deposit"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' }}
                  />
                  <button
                    onClick={handleDeposit}
                    style={{ background: 'var(--success)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer' }}
                  >
                    Deposit
                  </button>
                </div>

                <button
                  onClick={handleRevoke}
                  style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '5px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Revoke Access
                </button>
              </div>
            )}
          </div>

          {/* Vault Status Card */}
          <div className="card">
            <h2 className="card-title">Your Active Vault</h2>

            <div className="grid grid-cols-2 mt-4">
              <div>
                <div className="text-secondary" style={{ fontSize: '0.9rem' }}>Current Balance</div>
                <div className="card-value text-primary" style={{ fontSize: '2rem' }}>
                  {formatUnits(balanceVal, 18)}
                </div>
              </div>
              <div>
                <div className="text-secondary" style={{ fontSize: '0.9rem' }}>Initial Deposit</div>
                <div className="card-value" style={{ fontSize: '2rem' }}>
                  {formatUnits(initialDepositVal, 18)}
                </div>
              </div>
            </div>

            <div className="mt-8 p-6" style={{ borderTop: '1px solid var(--border)' }}>
              <p className="text-secondary" style={{ fontSize: '0.85rem', marginBottom: '15px' }}>
                * A 10% performance fee is automatically deducted from your yields upon withdrawal. This fee covers the protocol operations and the Acurast Job execution gas costs.
              </p>

              <button
                onClick={handleWithdraw}
                disabled={balanceVal === BigInt(0)}
                style={{
                  width: '100%',
                  background: balanceVal === BigInt(0) ? 'var(--surface-hover)' : 'var(--primary)',
                  color: balanceVal === BigInt(0) ? 'var(--text-secondary)' : '#fff',
                  border: 'none',
                  padding: '12px',
                  borderRadius: '8px',
                  cursor: balanceVal === BigInt(0) ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold'
                }}
              >
                Withdraw All Liquidity & Yields
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
