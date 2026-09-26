import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  // A self-contained server bundle for the Docker image (its Dockerfile sets NEXT_OUTPUT).
  // Elsewhere the regular build, so `next start` serves it.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  // The monorepo root, so the standalone bundle includes the workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write AGENTS.md / CLAUDE.md into the app folder during development.
  agentRules: false,
  // Two root layouts (console and tracking page) need one 404 page of their own.
  experimental: { globalNotFound: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
