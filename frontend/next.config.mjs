import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push(
      'pino-pretty',
      'lokijs',
      'encoding',
      '@metamask/connect-evm',
      'accounts',
      'porto',
      'porto/internal',
      '@safe-global/safe-apps-sdk',
      '@safe-global/safe-apps-provider',
      '@walletconnect/ethereum-provider'
    );
    return config;
  },
};

export default nextConfig;
