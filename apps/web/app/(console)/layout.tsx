import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import '../globals.css';

export const metadata: Metadata = {
  title: 'dispatch · console',
  description: 'Dispatcher console for live delivery tracking (portfolio demo).',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/**
 * Rendered per request, not at build time: Next.js can only put the Content-Security-Policy nonce
 * (proxy.ts) on the scripts of a page it renders for that request.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
