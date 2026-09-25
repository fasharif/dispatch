import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Not found · dispatch' };

export default function GlobalNotFound() {
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
