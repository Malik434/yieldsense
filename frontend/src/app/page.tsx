'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// Define the interface based on runtimeState.ts
interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number;
  yieldIndexerCheckpointBlock: number | null;
  rewardAprEwm: {
    mean: number;
    variance: number;
    lastTimestamp: number;
  } | null;
  gridTradesExecuted?: number;
  lastGridTradeAt?: number | null;
  error?: string;
  defaultState?: boolean;
}

export default function Dashboard() {
  const [state, setState] = useState<WorkerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchState = async () => {
    try {
      const res = await fetch('/api/state');
      const data = await res.json();
      setState(data);
      setLastRefreshed(new Date());
    } catch (err) {
      console.error('Failed to fetch state', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchState();
    // Poll every 10 seconds
    const interval = setInterval(fetchState, 10000);
    return () => clearInterval(interval);
  }, []);

  const formatPercent = (val: number | null) => {
    if (val === null) return 'N/A';
    return `${(val / 100).toFixed(2)}%`;
  };

  const formatTimeAgo = (timestampMs: number | null) => {
    if (!timestampMs) return 'Never';
    const seconds = Math.floor((Date.now() - timestampMs) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const isHealthy = state && state.apiFailureStreak === 0 && !state.defaultState;
  const isWarning = state && state.apiFailureStreak > 0 && state.apiFailureStreak < 3;
  const isError = !state || state.apiFailureStreak >= 3 || state.defaultState;

  const getStatusClass = () => {
    if (isHealthy) return 'healthy';
    if (isWarning) return 'warning';
    return 'error';
  };

  const getStatusText = () => {
    if (isHealthy) return 'Worker Active';
    if (isWarning) return 'API Retrying';
    if (state?.defaultState) return 'No State File Found';
    return 'Worker Halted / Circuit Breaker';
  };

  if (loading && !state) {
    return (
      <main className="container">
        <header className="header">
          <h1>YieldSense Dashboard</h1>
          <div className="skeleton" style={{ width: '120px', height: '32px' }}></div>
        </header>
        <div className="grid grid-cols-4">
          <div className="card skeleton" style={{ height: '120px' }}></div>
          <div className="card skeleton" style={{ height: '120px' }}></div>
          <div className="card skeleton" style={{ height: '120px' }}></div>
          <div className="card skeleton" style={{ height: '120px' }}></div>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <h1>YieldSense Dashboard</h1>
          <Link href="/vault" style={{ textDecoration: 'none', background: 'var(--surface-hover)', padding: '8px 16px', borderRadius: '8px', color: 'var(--text-primary)', border: '1px solid var(--border)', fontSize: '0.9rem' }}>
            Go to Vault →
          </Link>
        </div>
        <div className="status-indicator">
          <span className={`dot ${getStatusClass()}`}></span>
          {getStatusText()}
        </div>
      </header>

      <div className="grid grid-cols-4">
        {/* Total APR Card */}
        <div className="card">
          <div className="card-title">Total APR</div>
          <div className="card-value text-primary">
            {state?.defaultState ? '---' : formatPercent(state?.previousApr || null)}
          </div>
        </div>

        {/* Reward APR (EWMA) */}
        <div className="card">
          <div className="card-title">Reward APR (Smoothed)</div>
          <div className="card-value" style={{ color: 'var(--text-primary)' }}>
            {state?.defaultState ? '---' : formatPercent(state?.rewardAprEwm?.mean || null)}
          </div>
        </div>

        {/* Last Execution */}
        <div className="card">
          <div className="card-title">Last Harvest Execution</div>
          <div className="card-value" style={{ color: 'var(--success)' }}>
            {state?.defaultState ? '---' : formatTimeAgo(state?.lastExecutionAt || null)}
          </div>
        </div>

        {/* API Failure Streak */}
        <div className="card">
          <div className="card-title">API Failure Streak</div>
          <div className="card-value" style={{ color: state?.apiFailureStreak === 0 ? 'var(--text-secondary)' : 'var(--danger)' }}>
            {state?.defaultState ? '---' : state?.apiFailureStreak || 0}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 mt-8">
        {/* Worker Info */}
        <div className="card">
          <div className="card-title">Worker Runtime Info</div>
          <div className="mt-4" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.95rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-secondary">Last Run:</span>
              <span>{state?.defaultState ? '---' : formatTimeAgo(state?.lastRunAt || null)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-secondary">Next Check In:</span>
              <span>{state?.suggestedNextCheckMs ? `${state.suggestedNextCheckMs / 1000}s` : '---'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-secondary">Indexer Checkpoint:</span>
              <span>{state?.yieldIndexerCheckpointBlock || '---'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-secondary">Last Decision Reason:</span>
              <span style={{ color: 'var(--warning)', textAlign: 'right', maxWidth: '60%' }}>
                {state?.defaultState ? '---' : state?.lastDecisionReason || 'None'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
              <span className="text-secondary">Grid Trades Executed:</span>
              <span style={{ color: 'var(--primary)' }}>{state?.gridTradesExecuted || 0}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-secondary">Last Grid Trade:</span>
              <span>{state?.defaultState ? '---' : formatTimeAgo(state?.lastGridTradeAt || null)}</span>
            </div>
          </div>
        </div>
      </div>

      <footer className="mt-8 text-secondary" style={{ fontSize: '0.8rem', textAlign: 'center' }}>
        Last refreshed: {lastRefreshed?.toLocaleTimeString() || '...'}
      </footer>
    </main>
  );
}
