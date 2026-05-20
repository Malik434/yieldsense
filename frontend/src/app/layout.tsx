import type { Metadata } from "next";
import { Web3Provider } from "@/providers/Web3Provider";
import { NetworkProvider } from "@/providers/NetworkProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "YieldSense | Confidential Strategy Vault on Base",
  description: "Acurast TEE-powered confidential DeFi strategies. Encrypted stop-losses, private grid trading, and verified yields on Base — front-run protected.",
  keywords: ["DeFi", "Base", "Acurast", "TEE", "confidential", "yield", "strategy"],
  openGraph: {
    title: "YieldSense — Confidential Strategy Vault",
    description: "Your strategy. Encrypted. Verified by hardware.",
    type: "website",
  },
  other: {
    "base:app_id": "69f692b1ffffb1a0ba553eff",
    "talentapp:project_verification": "7a4adcc55a1ed33e1dbb9a4c399afe7bbb41e509db79cd7d429732beb88ca7a0fab8ef2b5b46f2258af79607545cb1888358ba1c5f34b2e10883da96fb73be17",
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
          <NetworkProvider>
            {children}
          </NetworkProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
