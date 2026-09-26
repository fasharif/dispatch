import type { Metadata } from 'next';
import { connection } from 'next/server';
import './globals.css';

export const metadata: Metadata = { title: 'Not found · dispatch' };

/** Rendered per request, so its scripts carry the Content-Security-Policy nonce (proxy.ts). */
export default async function GlobalNotFound() {
  await connection();
  return (
    <html lang="en" dir="ltr">
      <body>
        <main className="login">
          <div className="card login-card">
            <h1>Page not found</h1>
            <p className="muted">
              This address does not exist. Tracking links look like <code>/track/v1.…</code>; ask
              the sender for a new one if yours stopped working.
            </p>
          </div>
        </main>
      </body>
    </html>
  );
}
