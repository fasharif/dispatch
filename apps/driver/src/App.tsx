import type { DeliveryDto } from '@dispatch/shared';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { DriverApi } from './api/client';
import { stopTracking } from './location/tracking';
import { getQueue } from './queue/instance';
import { EnrolScreen } from './screens/EnrolScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ProofScreen } from './screens/ProofScreen';
import { clearCredentials, loadCredentials, type Credentials } from './storage/credentials';

type Screen =
  | { name: 'loading' }
  | { name: 'enrol' }
  | { name: 'home' }
  | { name: 'proof'; delivery: DeliveryDto };

export function App() {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await loadCredentials();
      if (!saved) {
        setScreen({ name: 'enrol' });
        return;
      }
      // Bind the queue to this device; a new device id starts a new sequence of fixes.
      await (await getQueue()).bindDevice(saved.deviceId);
      setCredentials(saved);
      setScreen({ name: 'home' });
    })();
  }, []);

  const api = useMemo(
    () => (credentials ? new DriverApi(credentials.apiUrl, credentials.deviceToken) : null),
    [credentials],
  );

  const signOut = useCallback(() => {
    void (async () => {
      await stopTracking();
      await clearCredentials();
      setCredentials(null);
      setNotice('This phone is no longer enrolled. Ask your dispatcher for a new code.');
      setScreen({ name: 'enrol' });
    })();
  }, []);

  if (screen.name === 'loading') {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (screen.name === 'enrol' || !api) {
    return (
      <>
        <StatusBar style="dark" />
        <EnrolScreen
          notice={notice}
          onEnrolled={(saved) => {
            void (async () => {
              await (await getQueue()).bindDevice(saved.deviceId);
              setNotice(null);
              setCredentials(saved);
              setScreen({ name: 'home' });
            })();
          }}
        />
      </>
    );
  }
  if (screen.name === 'proof') {
    return (
      <ProofScreen
        api={api}
        delivery={screen.delivery}
        onDone={() => setScreen({ name: 'home' })}
        onCancel={() => setScreen({ name: 'home' })}
      />
    );
  }
  return (
    <>
      <StatusBar style="dark" />
      <HomeScreen
        api={api}
        onProof={(delivery) => setScreen({ name: 'proof', delivery })}
        onUnauthorized={signOut}
      />
    </>
  );
}
