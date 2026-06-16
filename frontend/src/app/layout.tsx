import type { Metadata } from "next";
import { Web3Provider } from "@/providers/Web3Provider";
import { NetworkProvider } from "@/providers/NetworkProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "YieldSense | Autonomous Yield and Grid Strategies on Base",
  description:
    "YieldSense coordinates autonomous yield vaults and grid strategies on Base with Acurast processor orchestration and on-chain execution controls.",
  keywords: ["DeFi", "Base", "Acurast", "TEE", "confidential", "yield", "strategy"],
  openGraph: {
    title: "YieldSense",
    description: "Autonomous yield vaults and grid strategies on Base, powered by Acurast processors.",
    type: "website",
  },
  other: {
    "base:app_id": "69f692b1ffffb1a0ba553eff",
    "talentapp:project_verification":
      "7a4adcc55a1ed33e1dbb9a4c399afe7bbb41e509db79cd7d429732beb88ca7a0fab8ef2b5b46f2258af79607545cb1888358ba1c5f34b2e10883da96fb73be17",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Web3Provider>
          <NetworkProvider>{children}</NetworkProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
