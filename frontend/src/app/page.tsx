import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Blocks,
  Cpu,
  Database,
  ExternalLink,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Network,
  RadioTower,
  Sparkles,
  Zap,
} from "lucide-react";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.yieldsense.org";

const products = [
  {
    title: "Autonomous yield vault",
    text: "USDC vault automation for Aerodrome yield harvesting, profitability checks, and hourly processor orchestration.",
  },
  {
    title: "Grid strategy engine",
    text: "Pair-aware grid strategies with on-chain status checks, inventory guards, execution queues, and processor lease rotation.",
  },
  {
    title: "Processor orchestration",
    text: "Acurast lease metadata, telemetry, registry authorization, handoff safety, and operator-controlled automation switches.",
  },
];

const heroLogos = [
  {
    name: "Acurast",
    src: "https://hub.acurast.com/assets/acurast-logo.png",
  },
  {
    name: "Base",
    src: "https://avatars.githubusercontent.com/u/108554348?s=96&v=4",
  },
  {
    name: "Aerodrome",
    src: "https://aerodrome.finance/svg/AERO/favicon.svg",
  },
];

const architecture = [
  {
    title: "User control plane",
    text: "Users deposit, configure strategies, pause execution, and inspect processor health from the app.",
    icon: KeyRound,
  },
  {
    title: "Acurast decision plane",
    text: "Processors evaluate yield and grid opportunities inside hardware-backed execution environments.",
    icon: Cpu,
  },
  {
    title: "Base settlement plane",
    text: "ExecutorRegistry and strategy contracts enforce authorization before any vault or grid action settles.",
    icon: Blocks,
  },
];

const securityControls = [
  {
    title: "Rotating identities",
    text: "New processors register before execution and old identities revoke only after a healthy handoff.",
    icon: GitBranch,
  },
  {
    title: "On-chain truth",
    text: "Grid execution verifies strategy status, balances, and snapshots on-chain before trading.",
    icon: LockKeyhole,
  },
  {
    title: "Telemetry epochs",
    text: "Telemetry links deployment id, processor address, and lease epoch for clear lifecycle ownership.",
    icon: RadioTower,
  },
  {
    title: "Metadata only",
    text: "Postgres stores lifecycle state and queue metadata, while contracts remain the execution guard.",
    icon: Database,
  },
];

function ProductMockup() {
  return (
    <div
      className="landing-product-frame"
      aria-label="YieldSense product preview"
    >
      <Image
        src="/yieldsense-dashboard.png"
        alt="YieldSense dashboard showing vault allocation, grid trading, and processor orchestration"
        width={1280}
        height={860}
        priority
        className="landing-dashboard-image"
      />
    </div>
  );
}

function SectionTitle({
  title,
  text,
  dark = false,
}: {
  title: string;
  text: string;
  dark?: boolean;
}) {
  return (
    <div className="landing-section-title">
      <h2 className={dark ? "text-white" : "text-[#07110D]"}>{title}</h2>
      <p className={dark ? "text-white/62" : "text-[#47524D]"}>{text}</p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <Link href="/" className="landing-brand" aria-label="YieldSense home">
          <span className="landing-logo">
            <Image src="/YieldSenseLogo.png" alt="" fill sizes="40px" />
          </span>
          YieldSense
        </Link>
        <div className="landing-nav-links">
          <a href="#product">Product</a>
          <a href="#architecture">Architecture</a>
          <a href="#partners">Partners</a>
          <a href="#security">Security</a>
        </div>
        <a href={APP_URL} className="landing-nav-cta">
          Launch app
          <ArrowRight size={16} />
        </a>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <h1>YieldSense</h1>
          <p>
            Autonomous yield vaults and grid strategies on Base, coordinated by
            Acurast processors and guarded by on-chain authorization.
          </p>
          <div className="landing-hero-actions">
            <a href={APP_URL} className="landing-primary">
              Launch app
              <ArrowRight size={18} />
            </a>
            <a href="#architecture" className="landing-secondary">
              Read architecture
            </a>
          </div>
          <div className="landing-logo-rail" aria-label="YieldSense ecosystem">
            <p>Built across trusted infrastructure</p>
            <div>
              {heroLogos.map(({ name, src }) => (
                <span key={name}>
                  <img src={src} alt="" loading="lazy" />
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
        <ProductMockup />
      </section>

      <section id="product" className="landing-section">
        <SectionTitle
          title="Major systems in YieldSense"
          text="The product is built around automated execution, explicit user control, and contract-level safety checks."
        />
        <div className="landing-product-list">
          {products.map((product, index) => (
            <article key={product.title} className="landing-product-item">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{product.title}</h3>
                <p>{product.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="partners" className="landing-partners">
        <SectionTitle
          dark
          title="Built with Acurast and Base"
          text="YieldSense combines private off-chain computation with Base mainnet settlement for automated DeFi execution."
        />
        <div className="landing-partner-grid">
          <article>
            <Cpu size={24} />
            <h3>Acurast builders spotlight</h3>
            <p>
              YieldSense is positioned as an Acurast Builders Spotlight product:
              a practical processor orchestration system for private strategy
              evaluation, telemetry, lease renewal, and hardware-backed
              execution.
            </p>
          </article>
          <article>
            <Network size={24} />
            <h3>Base Builders Program</h3>
            <p>
              The protocol is designed around Base-native contracts, USDC
              liquidity, ExecutorRegistry authorization, and user-facing
              automation for the Base builder ecosystem.
            </p>
          </article>
          <article>
            <Sparkles size={24} />
            <h3>Production roadmap</h3>
            <p>
              Current work focuses on reliable Acurast deployment adapters,
              processor identity rotation, Postgres orchestration state, and
              app-domain separation.
            </p>
          </article>
        </div>
      </section>

      <section
        id="architecture"
        className="landing-section landing-architecture"
      >
        <SectionTitle
          title="Three-plane architecture"
          text="YieldSense separates user interaction, processor decisions, and final settlement so each layer has a narrow responsibility."
        />
        <div className="landing-arch-flow">
          {architecture.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title}>
                <Icon size={26} />
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section id="security" className="landing-security">
        <div>
          <SectionTitle
            dark
            title="Execution safety before automation"
            text="The automation layer is intentionally conservative: a processor cannot trade just because lifecycle state says it should run."
          />
          <a href={APP_URL} className="landing-dark-link">
            Open command center
            <ExternalLink size={16} />
          </a>
        </div>
        <div className="landing-security-list">
          {securityControls.map((item) => (
            <article key={item.title}>
              <div>
                <item.icon size={22} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section landing-final">
        <h2>
          Deploy strategies with a control plane built for rotating processors.
        </h2>
        <p>
          Launch the app to manage yield vault deposits, grid strategies,
          processor orchestration, telemetry, and execution history.
        </p>
        <a href={APP_URL} className="landing-primary">
          Launch app
          <ArrowRight size={18} />
        </a>
      </section>
    </main>
  );
}
