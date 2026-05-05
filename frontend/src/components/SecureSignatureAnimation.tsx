'use client';

import { useEffect, useState } from 'react';
import { Shield, ShieldCheck, Cpu, Fingerprint, Lock, Loader2 } from 'lucide-react';

interface SecureSignatureAnimationProps {
  onComplete: () => void;
}

const CIPHER_CHARS = '0123456789ABCDEF!@#$%^&*';

function randomCipherText(length: number): string {
  return Array.from({ length }, () =>
    CIPHER_CHARS[Math.floor(Math.random() * CIPHER_CHARS.length)]
  ).join('');
}

const STAGES = [
  { label: 'Initializing Secure Enclave', sublabel: 'PROVISIONING TEE HANDSHAKE', progress: 15 },
  { label: 'Encrypting Strategy Intent', sublabel: 'EIP-712 · AES-256-GCM', progress: 40 },
  { label: 'Attesting Identity Proof', sublabel: 'P-256 HARDWARE SIGNATURE', progress: 70 },
  { label: 'Committing to Autonomous Guardian', sublabel: 'ENCLAVE STORAGE LOCKED', progress: 100 },
];

export function SecureSignatureAnimation({ onComplete }: SecureSignatureAnimationProps) {
  const [stage, setStage] = useState(0);
  const [cipher, setCipher] = useState(randomCipherText(48));
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Cycle cipher text
    const cipherInterval = setInterval(() => {
      setCipher(randomCipherText(48));
    }, 50);

    // Advance stages
    const timings = [800, 1800, 2800, 3800];
    const timeouts = timings.map((t, i) =>
      setTimeout(() => setStage(i), t)
    );

    // Done
    const doneTimeout = setTimeout(() => {
      setDone(true);
      clearInterval(cipherInterval);
      setTimeout(onComplete, 800);
    }, 4500);

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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#030605]/95 backdrop-blur-xl animate-fade-in"
      style={{
        animation: done ? 'fade-out 0.4s ease-in forwards' : 'fade-in 0.4s ease-out',
      }}
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#C2E812]/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative w-full max-w-md p-10 flex flex-col items-center gap-10">
        {/* Hardware Icon Module */}
        <div className="relative group">
          <div className="absolute inset-0 bg-[#C2E812]/20 rounded-full blur-2xl animate-pulse" />
          <div className="relative w-24 h-24 rounded-3xl bg-[#0B0F0D] border border-[#C2E812]/30 flex items-center justify-center shadow-2xl overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-[#C2E812]/10 to-transparent" />
            {done ? (
              <ShieldCheck size={40} className="text-[#00FFA3] animate-bounce-subtle" />
            ) : (
              <div className="relative">
                <Cpu size={40} className="text-[#C2E812] animate-pulse" />
                <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#00FFA3] rounded-full animate-ping" />
              </div>
            )}
          </div>
        </div>

        {/* Textual Feedback */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="space-y-1">
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA] tracking-tight">
              {done ? 'Strategy Securely Sealed' : current.label}
            </h3>
            <p className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-[0.4em]">
              {done ? 'Enclave Protection Active' : current.sublabel}
            </p>
          </div>
          
          <p className="text-xs font-mono text-[#484F58] max-w-[280px] leading-relaxed uppercase tracking-wider">
            {done 
              ? 'Autonomous agent has acknowledged your signed intent. Execution window is now live.' 
              : 'Cryptographic handshake in progress. Strategy parameters are being encrypted for hardware isolation.'}
          </p>
        </div>

        {/* Terminal/Cipher View */}
        {!done && (
          <div className="w-full ys-card p-4 bg-black/60 border-white/5 font-mono text-[10px] text-[#C2E812]/60 overflow-hidden whitespace-nowrap text-center tracking-[0.2em]">
            <span className="opacity-40">{cipher.slice(0, 16)}</span>
            <span className="mx-2 text-[#00FFA3] font-bold">{cipher.slice(16, 32)}</span>
            <span className="opacity-40">{cipher.slice(32)}</span>
          </div>
        )}

        {/* Progress Progress System */}
        <div className="w-full space-y-4">
          <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-[#C2E812] to-[#00FFA3] transition-all duration-700 ease-out shadow-[0_0_15px_rgba(194,232,18,0.3)]"
              style={{ width: `${done ? 100 : current.progress}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">
            <span>Enclave Sync</span>
            <span>{done ? 100 : current.progress}% Complete</span>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 opacity-60">
          <Lock size={12} className="text-[#484F58]" />
          <span className="text-[9px] font-mono text-[#8B949E] uppercase tracking-widest">Hardware-Locked Isolation</span>
        </div>
      </div>
    </div>
  );
}
