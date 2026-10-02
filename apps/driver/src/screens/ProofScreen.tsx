import type { DeliveryDto, Signature } from '@dispatch/shared';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, type DriverApi } from '../api/client';
import { SignaturePad } from '../components/SignaturePad';
import { currentPosition } from '../location/tracking';
import { ui } from './styles';

interface ProofScreenProps {
  api: DriverApi;
  delivery: DeliveryDto;
  onDone: (delivery: DeliveryDto) => void;
  onCancel: () => void;
}

/** Photo, signature and position at the door; the server checks the position against the geofence. */
export function ProofScreen({ api, delivery, onDone, onCancel }: ProofScreenProps) {
  const [recipient, setRecipient] = useState(delivery.recipientName);
  const [photo, setPhoto] = useState<{ uri: string; mimeType: string } | null>(null);
  const [signature, setSignature] = useState<Signature | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per completion attempt, reused if the driver taps again after a lost response.
  const idempotencyKey = useRef(Crypto.randomUUID());
  const onSignature = useCallback((value: Signature | null) => {
    setSignature(value);
  }, []);

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera access is needed for the photo of the delivered parcel.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset) setPhoto({ uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg' });
  };

  const submit = async () => {
    if (!photo || !signature || !recipient.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const position = await currentPosition();
      const completed = await api.complete(
        delivery.id,
        {
          recipientName: recipient.trim(),
          position: { lat: position.lat, lng: position.lng },
          ...(position.accuracyM !== null && { accuracyM: position.accuracyM }),
          capturedAt: new Date().toISOString(),
          signature,
        },
        photo,
        idempotencyKey.current,
      );
      onDone(completed);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The proof could not be sent. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={ui.screen}>
      <Text style={ui.title}>Proof of delivery</Text>
      <Text style={ui.muted}>
        {delivery.orderReference} · {delivery.address}
      </Text>
      <Text style={ui.label}>Received by</Text>
      <TextInput style={ui.input} value={recipient} onChangeText={setRecipient} />
      <Pressable style={ui.secondary} onPress={() => void takePhoto()} accessibilityRole="button">
        <Text style={ui.secondaryText}>
          {photo ? 'Retake photo' : 'Take a photo of the parcel'}
        </Text>
      </Pressable>
      {photo && (
        <Image
          source={{ uri: photo.uri }}
          style={{ height: 180, borderRadius: 8 }}
          accessibilityLabel="Parcel photo"
        />
      )}
      <Text style={ui.label}>Signature</Text>
      <SignaturePad onChange={onSignature} />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={{ gap: 10 }}>
        <Pressable
          style={ui.primary}
          disabled={busy || !photo || !signature || !recipient.trim()}
          onPress={() => void submit()}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={ui.primaryText}>Complete delivery</Text>
          )}
        </Pressable>
        <Pressable style={ui.secondary} onPress={onCancel} accessibilityRole="button">
          <Text style={ui.secondaryText}>Back</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
