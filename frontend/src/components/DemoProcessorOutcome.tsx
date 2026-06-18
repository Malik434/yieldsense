"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpDown,
  CheckCircle2,
  Cpu,
  Play,
  RadioTower,
  ShieldCheck,
  Zap,
} from "lucide-react";

type DemoEvent = {
  event: string;
  processor: "Yield" | "Grid" | "Registry";
  message: string;
  timestamp: number;
  tone: "green" | "lime" | "blue";
};

const DEMO_PROCESSOR = "0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function eventToneClasses(tone: DemoEvent["tone"]) {
  if (tone === "green") return "border-[#00FFA3]/20 bg-[#00FFA3]/10 text-[#00FFA3]";
  if (tone === "blue") return "border-[#0052FF]/25 bg-[#0052FF]/10 text-[#8FB3FF]";
  return "border-[#C2E812]/20 bg-[#C2E812]/10 text-[#C2E812]";
}

const demoCycle: Omit<DemoEvent, "timestamp">[] = [
  {
    event: "yield_processor_identity",
    processor: "Yield",
    message: `TEE identity reported by ${shortAddress(DEMO_PROCESSOR)}`,
    tone: "green",
  },
  {
    event: "yield_hourly_check",
    processor: "Yield",
    message: "Dry run: vault APR checked, harvest below threshold",
    tone: "lime",
  },
  {
    event: "grid_strategy_loaded",
    processor: "Grid",
    message: "Dry run: 1 active strategy loaded from on-chain status",
    tone: "blue",
  },
  {
    event: "grid_trade_evaluated",
    processor: "Grid",
    message: "Dry run: price inside band, next grid level armed",
    tone: "lime",
  },
  {
    event: "registry_preflight",
    processor: "Registry",
    message: "ExecutorRegistry authorization verified before execution",
    tone: "green",
  },
];

export function DemoProcessorOutcome() {
  const [cursor, setCursor] = useState(0);
  const [events, setEvents] = useState<DemoEvent[]>(() =>
    demoCycle.slice(0, 3).map((event, index) => ({
      ...event,
      timestamp: Date.now() - (3 - index) * 45_000,
    })),
  );

  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

  useEffect(() => {
    if (!isDemoMode) return;

    const timer = setInterval(() => {
      setCursor((current) => {
        const next = (current + 1) % demoCycle.length;
        setEvents((existing) => [
          { ...demoCycle[next], timestamp: Date.now() },
          ...existing,
        ].slice(0, 7));
        return next;
      });
    }, 3500);

    return () => clearInterval(timer);
  }, [isDemoMode]);

  const stats = useMemo(
    () => [
      {
        label: "Yield processor",
        value: "Healthy",
        detail: "Hourly harvest check",
        icon: <Cpu size={16} />,
        tone: "text-[#00FFA3]",
      },
      {
        label: "Grid processor",
        value: "Watching",
        detail: "1 active strategy",
        icon: <ArrowUpDown size={16} />,
        tone: "text-[#C2E812]",
      },
      {
        label: "Registry guard",
        value: "Authorized",
        detail: "Preflight enabled",
        icon: <ShieldCheck size={16} />,
        tone: "text-[#8FB3FF]",
      },
    ],
    [],
  );

  if (!isDemoMode) return null;

  const appendManualTick = () => {
    const next = demoCycle[(cursor + 1) % demoCycle.length];
    setCursor((cursor + 1) % demoCycle.length);
    setEvents((existing) => [
      { ...next, timestamp: Date.now() },
      ...existing,
    ].slice(0, 7));
  };

  return (
    <section className="pt-5 sm:pt-8">
      <div className="ys-card overflow-hidden border-[#00FFA3]/10 bg-[#07100D]/75">
        <div className="grid gap-0 lg:grid-cols-[0.92fr_1.08fr]">
          <div className="border-b border-white/[0.06] p-5 sm:p-6 lg:border-b-0 lg:border-r">
            <div className="flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-[#00FFA3]/20 bg-[#00FFA3]/10 px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest text-[#00FFA3]">
                    <RadioTower size={12} />
                    Local processor dry run
                  </div>
                  <h2 className="mt-4 text-2xl font-heading font-bold tracking-tight text-[#F5F7FA] sm:text-3xl">
                    Processor outcomes visible for the demo
                  </h2>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#8B949E]">
                    These UI events simulate the Acurast processors while you record locally. They do not submit trades or harvest transactions.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={appendManualTick}
                  className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[#C2E812]/20 bg-[#C2E812]/10 px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#C2E812] transition-colors hover:bg-[#C2E812]/15"
                >
                  <Play size={13} />
                  Tick
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"
                  >
                    <div className={`mb-3 inline-flex rounded-xl border border-white/10 bg-black/25 p-2 ${stat.tone}`}>
                      {stat.icon}
                    </div>
                    <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
                      {stat.label}
                    </p>
                    <p className="mt-1 text-lg font-heading font-bold text-[#F5F7FA]">
                      {stat.value}
                    </p>
                    <p className="mt-1 text-xs text-[#8B949E]">{stat.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-[#C2E812]" />
                <span className="text-[10px] font-mono font-bold uppercase tracking-[0.22em] text-[#8B949E]">
                  Outcome stream
                </span>
              </div>
              <div className="inline-flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#00FFA3]">
                <span className="h-2 w-2 rounded-full bg-[#00FFA3] shadow-[0_0_14px_rgba(0,255,163,0.55)]" />
                Running
              </div>
            </div>

            <div className="space-y-3">
              {events.map((event, index) => {
                const date = new Date(event.timestamp);
                return (
                  <div
                    key={`${event.event}-${event.timestamp}-${index}`}
                    className="grid gap-3 rounded-2xl border border-white/[0.06] bg-black/20 p-3 sm:grid-cols-[auto_1fr_auto] sm:items-center"
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${eventToneClasses(event.tone)}`}>
                      {event.processor === "Yield" ? (
                        <Zap size={15} />
                      ) : event.processor === "Grid" ? (
                        <ArrowUpDown size={15} />
                      ) : (
                        <CheckCircle2 size={15} />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-heading font-bold text-[#F5F7FA]">
                        {event.message}
                      </p>
                      <p className="mt-1 break-all text-[10px] font-mono uppercase tracking-wider text-[#484F58]">
                        {event.event}
                      </p>
                    </div>
                    <div className="text-left text-[10px] font-mono font-bold uppercase tracking-wider text-[#484F58] sm:text-right">
                      {date.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
