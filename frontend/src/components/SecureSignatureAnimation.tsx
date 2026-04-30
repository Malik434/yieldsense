'use client';

import { useEffect, useState } from 'react';
import { Shield, Lock, ShieldCheck, X } from 'lucide-react';

interface SecureSignatureAnimationProps {
  onComplete: () => void;
}

const CIPHER_CHARS = '!@#$%^&*ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789';

function randomCipherText(length: number): string {
  return Array.from({ length }, () =>
    CIPHER_CHARS[Math.floor(Math.random() * CIPHER_CHARS.length)]
  ).join('');
}

const STAGES = [
  { label: 'INITIATING SECURE CHANNEL', sublabel: 'TEE HANDSHAKE', progress: 15 },
  { label: 'ENCRYPTING PARAMETERS', sublabel: 'AES-256-GCM · ACURAST ENCLAVE', progress: 40 },
  { label: 'SIGNING WITH TEE KEY', sublabel: 'P-256 · SECURE ELEMENT', progress: 70 },
  { label: 'STRATEGY COMMITTED', sublabel: 'NOT STORED ON-CHAIN', progress: 100 },
];

export function SecureSignatureAnimation({ onComplete }: SecureSignatureAnimationProps) {
  const [stage, setStage] = useState(0);
  const [cipher, setCipher] = useState(randomCipherText(32));
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Cycle cipher text
    const cipherInterval = setInterval(() => {
      setCipher(randomCipherText(32));
    }, 80);

    // Advance stages
    const timings = [600, 1400, 2200, 3000];
    const timeouts = timings.map((t, i) =>
      setTimeout(() => setStage(i), t)
    );

    // Done
    const doneTimeout = setTimeout(() => {
      setDone(true);
      clearInterval(cipherInterval);
      setTimeout(onComplete, 600);
    }, 3600);

    return () => {
      clearInterval(cipherInterval);
      timeouts.forEach(clearTimeout);
      clearTimeout(doneTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = STAGES[Math.min(stage, STAGES.length - 1)];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: 'rgba(0, 0, 0, 0.92)',
        backdropFilter: 'blur(12px)',
        animation: done ? 'fade-in 0.3s ease-out reverse' : 'fade-in 0.3s ease-out',
      }}
    >
      <div
        className="flex flex-col items-center gap-6 p-10 rounded-2xl"
        style={{
          background: 'linear-gradient(135deg, #0d1117 0%, #0f1a25 100%)',
          border: '1px solid rgba(139, 92, 246, 0.4)',
          boxShadow: '0 0 60px rgba(139, 92, 246, 0.15), 0 0 120px rgba(0, 212, 255, 0.05)',
          minWidth: 380,
          animation: 'slide-up 0.3s ease-out',
        }}
      >
        {/* Shield icon with glow */}
        <div className="relative">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(139,92,246,0.3) 0%, transparent 70%)',
              animation: 'glow-pulse 1.5s ease-in-out infinite',
              transform: 'scale(2)',
            }}
          />
          <div
            className="relative flex items-center justify-center w-20 h-20 rounded-full"
            style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(0,212,255,0.1))',
              border: '2px solid rgba(139,92,246,0.6)',
            }}
          >
            {done ? (
              <ShieldCheck size={36} style={{ color: '#00ff9f' }} />
            ) : (
              <Shield size={36} style={{ color: '#a78bfa' }} />
            )}
          </div>
        </div>

        {/* Status label */}
        <div className="flex flex-col items-center gap-1 text-center">
          <span
            className="font-mono font-bold tracking-widest"
            style={{ fontSize: 12, color: done ? '#00ff9f' : '#a78bfa', letterSpacing: '0.15em' }}
          >
            {done ? 'STRATEGY SECURED' : current.label}
          </span>
          <span
            className="font-mono"
            style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.1em' }}
          >
            {done ? 'ENCRYPTED IN TEE · FRONT-RUN PROTECTED' : current.sublabel}
          </span>
        </div>

        {/* Cipher stream */}
        {!done && (
          <div
            className="rounded-lg px-4 py-2 font-mono text-center"
            style={{
              background: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(139,92,246,0.2)',
              color: 'rgba(139,92,246,0.8)',
              fontSize: 11,
              letterSpacing: '0.08em',
              fontWeight: 500,
              minWidth: 300,
            }}
          >
            {cipher}
          </div>
        )}

        {/* Progress bar */}
        <div
          className="w-full rounded-full overflow-hidden"
          style={{ height: 3, background: 'rgba(255,255,255,0.06)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${done ? 100 : current.progress}%`,
              background: done
                ? 'linear-gradient(90deg, #00ff9f, #00d4ff)'
                : 'linear-gradient(90deg, #8b5cf6, #00d4ff)',
              boxShadow: done
                ? '0 0 8px rgba(0,255,159,0.6)'
                : '0 0 8px rgba(139,92,246,0.6)',
            }}
          />
        </div>

        <p
          className="font-mono text-center"
          style={{ fontSize: 10, color: '#334155', letterSpacing: '0.08em' }}
        >
          {done
            ? 'Your parameters are invisible to validators and MEV bots'
            : 'Your strategy is being encrypted and committed to the Acurast TEE'}
        </p>
      </div>
    </div>
  );
}
