import type { Metadata } from "next";
import { Web3Provider } from "@/providers/Web3Provider";
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
          {children}
        </Web3Provider>
      </body>
    </html>
  );
}
