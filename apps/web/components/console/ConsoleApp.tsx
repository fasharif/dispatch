'use client';

import type { DispatcherDto, LoginResult } from '@dispatch/shared';
import { useCallback, useState } from 'react';
import { Dashboard } from './Dashboard';
import { LoginForm } from './LoginForm';

/**
 * The access token is kept in memory only: it never reaches storage that other scripts could
 * read later, and reloading the page asks for the password again (see docs/decisions.md).
 */
export function ConsoleApp() {
  const [session, setSession] = useState<{ token: string; dispatcher: DispatcherDto } | null>(null);
  const signOut = useCallback(() => {
    setSession(null);
  }, []);

  if (!session) {
    return (
      <LoginForm
        onSignedIn={(result: LoginResult) => {
          setSession({ token: result.accessToken, dispatcher: result.dispatcher });
        }}
      />
    );
  }
  return <Dashboard token={session.token} dispatcher={session.dispatcher} onSignOut={signOut} />;
}
