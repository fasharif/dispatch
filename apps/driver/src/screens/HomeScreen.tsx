import type { DeliveryDto, DriverDto } from '@dispatch/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError, type DriverApi } from '../api/client';
import { requestLocationPermissions, startTracking, stopTracking } from '../location/tracking';
import { getQueue, syncQueue } from '../queue/instance';
import type { ReplayResult } from '../queue/replay';
import { ui } from './styles';

interface HomeScreenProps {
  api: DriverApi;
  onProof: (delivery: DeliveryDto) => void;
  onUnauthorized: () => void;
}

const STATUS: Record<DeliveryDto['status'], string> = {
  pending: 'Waiting',
  assigned: 'Go to the pickup point',
  picked_up: 'On the way to the customer',
  delivered: 'Delivered',
  failed: 'Not delivered',
  cancelled: 'Cancelled',
};

/** Shift switch, the delivery in hand and the state of the offline queue. */
export function HomeScreen({ api, onProof, onUnauthorized }: HomeScreenProps) {
  const [driver, setDriver] = useState<DriverDto | null>(null);
  const [delivery, setDelivery] = useState<DeliveryDto | null>(null);
  const [queued, setQueued] = useState(0);
  const [lastSync, setLastSync] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => {
    setReload((n) => n + 1);
  }, []);

  // Reload the driver, the delivery and the queue size on demand and every 10 seconds, and send
  // queued positions each time.
  useEffect(() => {
    let active = true;
    api.me().then(
      (home) => {
        if (!active) return;
        setDriver(home.driver);
        setDelivery(home.activeDelivery);
        setError(null);
      },
      (caught: unknown) => {
        if (!active) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else
          setError(
            'Offline: your positions are kept on the phone and sent when the signal returns.',
          );
      },
    );
    void getQueue()
      .then((queue) => queue.stats())
      .then((stats) => {
        if (active) setQueued(stats.queued);
      });
    const timer = setTimeout(() => {
      void syncQueue()
        .then((result) => {
          if (!active) return;
          if (result) setLastSync(result);
          if (result?.stoppedBy === 'unauthorized') onUnauthorized();
        })
        .finally(refresh);
    }, 10_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, reload, refresh, onUnauthorized]);

  const toggleShift = async () => {
    if (!driver) return;
    try {
      if (driver.status === 'offline') {
        const problem = await requestLocationPermissions();
        if (problem) {
          Alert.alert(
            'Location needed',
            problem === 'foreground-denied'
              ? 'Allow location access to start your shift.'
              : 'Choose "Allow all the time" so your position keeps updating when the app is in the background.',
          );
          return;
        }
        await startTracking();
        setDriver(await api.setShift(true));
      } else {
        setDriver(await api.setShift(false));
        await stopTracking();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The shift could not be changed.');
    }
  };

  const pickUp = async () => {
    if (!delivery) return;
    try {
      setDelivery(await api.pickUp(delivery.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Pickup could not be recorded.');
    }
  };

  const fail = () => {
    if (!delivery) return;
    Alert.alert('Cannot deliver?', 'The dispatcher will be told.', [
      { text: 'Back', style: 'cancel' },
      {
        text: 'Nobody at the address',
        onPress: () => void api.fail(delivery.id, 'Nobody at the address').then(refresh),
      },
      {
        text: 'Address not found',
        onPress: () => void api.fail(delivery.id, 'Address not found').then(refresh),
      },
    ]);
  };

  const onShift = driver !== null && driver.status !== 'offline';
  return (
    <ScrollView contentContainerStyle={ui.screen}>
      <Text style={ui.title}>{driver?.name ?? 'dispatch driver'}</Text>
      <Text style={ui.muted}>
        {onShift ? 'On shift: your position is shared with dispatch.' : 'Off shift.'}
      </Text>
      {error && <Text style={ui.notice}>{error}</Text>}

      <Pressable
        style={onShift ? ui.secondary : ui.primary}
        onPress={() => void toggleShift()}
        accessibilityRole="button"
      >
        <Text style={onShift ? ui.secondaryText : ui.primaryText}>
          {onShift ? 'End shift' : 'Start shift'}
        </Text>
      </Pressable>

      {delivery ? (
        <View style={ui.card}>
          <Text style={ui.subtitle}>{delivery.orderReference}</Text>
          <Text>{STATUS[delivery.status]}</Text>
          <Text style={ui.muted}>
            {delivery.recipientName}
            {delivery.recipientPhone ? ` · ${delivery.recipientPhone}` : ''}
          </Text>
          <Text>{delivery.address}</Text>
          {delivery.notes && <Text style={ui.muted}>{delivery.notes}</Text>}
          {delivery.status === 'assigned' && (
            <Pressable style={ui.primary} onPress={() => void pickUp()} accessibilityRole="button">
              <Text style={ui.primaryText}>Parcel picked up</Text>
            </Pressable>
          )}
          {delivery.status === 'picked_up' && (
            <Pressable
              style={ui.primary}
              onPress={() => onProof(delivery)}
              accessibilityRole="button"
            >
              <Text style={ui.primaryText}>Deliver: photo and signature</Text>
            </Pressable>
          )}
          <Pressable onPress={fail} accessibilityRole="button">
            <Text style={ui.danger}>Cannot deliver</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={ui.muted}>{onShift ? 'No delivery yet. Dispatch will assign one.' : ''}</Text>
      )}

      <View style={ui.card}>
        <Text style={ui.label}>Positions waiting to be sent: {queued}</Text>
        {lastSync && (
          <Text style={ui.muted}>
            Last sync: {lastSync.accepted} sent, {lastSync.duplicates} already received
            {lastSync.stoppedBy === 'offline' ? ', no connection' : ''}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
