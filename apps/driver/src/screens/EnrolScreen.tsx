import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, DriverApi } from '../api/client';
import { DEFAULT_API_URL, saveCredentials, type Credentials } from '../storage/credentials';
import { ui } from './styles';

/** First run: the driver types the one-time code the dispatcher gave them. */
export function EnrolScreen({
  notice,
  onEnrolled,
}: {
  notice: string | null;
  onEnrolled: (c: Credentials) => void;
}) {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await DriverApi.enrol(apiUrl.trim(), code, 'Driver phone');
      const credentials: Credentials = {
        apiUrl: apiUrl.trim(),
        deviceId: result.deviceId,
        deviceToken: result.deviceToken,
        driverName: result.driver.name,
      };
      await saveCredentials(credentials);
      onEnrolled(credentials);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Enrolment failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.screen}>
      <Text style={ui.title}>dispatch driver</Text>
      <Text style={ui.muted}>Enter the enrolment code from your dispatcher. It works once.</Text>
      {notice && <Text style={ui.notice}>{notice}</Text>}
      <Text style={ui.label}>Dispatch server</Text>
      <TextInput
        style={ui.input}
        value={apiUrl}
        onChangeText={setApiUrl}
        autoCapitalize="none"
        keyboardType="url"
      />
      <Text style={ui.label}>Enrolment code</Text>
      <TextInput
        style={[ui.input, styles.code]}
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={9}
        placeholder="ABCD-2345"
      />
      {error && <Text style={ui.error}>{error}</Text>}
      <Pressable
        style={ui.primary}
        onPress={() => void enrol()}
        disabled={busy || code.length < 8}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={ui.primaryText}>Enrol this phone</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({ code: { letterSpacing: 4, fontSize: 22 } });
