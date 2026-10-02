'use client';

import type { LoginResult } from '@dispatch/shared';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '@/lib/api';

export function LoginForm({ onSignedIn }: { onSignedIn: (result: LoginResult) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<LoginResult>('/v1/auth/login', {
        body: { email: form.get('email'), password: form.get('password') },
      });
      onSignedIn(result);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form
        className="card login-card"
        onSubmit={(event) => void submit(event)}
        aria-labelledby="login-title"
      >
        <h1 id="login-title">dispatch</h1>
        <p className="muted">Dispatcher console. Sign in to see drivers and deliveries live.</p>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required defaultValue="" />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
