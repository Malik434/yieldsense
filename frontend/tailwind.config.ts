import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'cyber-bg': '#080a0f',
        'cyber-surface': '#0d1117',
        'cyber-surface-2': '#131921',
        'cyber-border': 'rgba(0, 255, 159, 0.12)',
        'cyber-border-dim': 'rgba(255, 255, 255, 0.06)',
        'neon-green': '#00ff9f',
        'neon-green-dim': 'rgba(0, 255, 159, 0.15)',
        'neon-purple': '#8b5cf6',
        'neon-purple-dim': 'rgba(139, 92, 246, 0.15)',
        'neon-cyan': '#00d4ff',
        'neon-cyan-dim': 'rgba(0, 212, 255, 0.15)',
        'neon-amber': '#f59e0b',
        'neon-red': '#ff4466',
        'text-primary': '#e2e8f0',
        'text-secondary': '#64748b',
        'text-dim': '#334155',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'neon-green': '0 0 20px rgba(0, 255, 159, 0.3)',
        'neon-purple': '0 0 20px rgba(139, 92, 246, 0.3)',
        'neon-cyan': '0 0 20px rgba(0, 212, 255, 0.3)',
        'card': '0 4px 32px rgba(0, 0, 0, 0.4)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '1' },
          '100%': { transform: 'scale(2)', opacity: '0' },
        },
        'scanline': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        'heartbeat': {
          '0%, 100%': { transform: 'scaleX(1)' },
          '10%': { transform: 'scaleX(1.05)' },
          '20%': { transform: 'scaleX(0.95)' },
        },
        'cipher-scroll': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '20%': { opacity: '1', transform: 'translateY(0)' },
          '80%': { opacity: '1', transform: 'translateY(0)' },
          '100%': { opacity: '0', transform: 'translateY(-4px)' },
        },
        'secure-shimmer': {
          '0%': { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200% center' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'ekg': {
          '0%': { strokeDashoffset: '200' },
          '100%': { strokeDashoffset: '0' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.5s ease-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'heartbeat': 'heartbeat 1s ease-in-out infinite',
        'cipher-scroll': 'cipher-scroll 3s ease-in-out infinite',
        'secure-shimmer': 'secure-shimmer 2s linear infinite',
        'slide-up': 'slide-up 0.4s ease-out',
        'fade-in': 'fade-in 0.3s ease-out',
        'scanline': 'scanline 8s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
