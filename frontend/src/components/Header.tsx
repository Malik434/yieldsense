'use client';

import { ShieldCheck, Cpu, Bell, Activity, ChevronDown, LayoutGrid, BookMarked, RotateCw } from 'lucide-react';
import { WalletButton } from './WalletButton';

interface HeaderProps {
  isHealthy: boolean;
  isWarning: boolean;
}

export function Header({ isHealthy, isWarning }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 w-full bg-[#030605]/80 backdrop-blur-xl border-b border-white/[0.05]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Brand & User Selector */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 group cursor-pointer">
            <div className="w-8 h-8 rounded-lg bg-[#C2E812] flex items-center justify-center shadow-lg shadow-[#C2E812]/20">
              <ShieldCheck size={18} className="text-[#030605]" />
            </div>
            <div className="flex flex-col">
              <h1 className="text-sm font-heading font-bold text-[#F5F7FA] tracking-tight">
                YieldSense
              </h1>
              <span className="text-[8px] font-mono font-bold text-[#C2E812] uppercase tracking-widest opacity-80">
                Guardian v1
              </span>
            </div>
          </div>

          <div className="h-8 w-px bg-white/[0.08] mx-2 hidden md:block" />


        </div>


        {/* Actions & Status */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-6 pr-6 border-r border-white/[0.05]">
            <div className="flex flex-col items-end">
              <span className="text-[8px] font-mono font-bold text-[#484F58] uppercase tracking-widest mb-0.5">Network</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${isHealthy ? 'bg-[#C2E812]' : 'bg-amber-400'}`} />
                <span className="text-[10px] font-mono font-bold text-[#F5F7FA] uppercase tracking-wider">
                  Base
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="p-2 rounded-xl bg-white/5 border border-white/5 text-[#484F58] hover:text-[#F5F7FA] transition-all group">
              <RotateCw size={18} className="group-hover:rotate-180 transition-transform duration-700" />
            </button>
            <WalletButton />
          </div>
        </div>
      </div>
    </header>
  );
}
