import * as SecureStore from 'expo-secure-store';

/** Where this phone talks to, and the device token it received at enrolment. */
export interface Credentials {
  apiUrl: string;
  deviceId: string;
  deviceToken: string;
  driverName: string;
}

const KEY = 'dispatch.credentials';

/** Kept in the Keychain / Android Keystore, never in plain storage. */
export async function loadCredentials(): Promise<Credentials | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Credentials;
  } catch {
    await SecureStore.deleteItemAsync(KEY);
    return null;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(credentials));
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/** The API origin the app suggests at enrolment; EXPO_PUBLIC_API_URL is set at build time. */
export const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:57100';
