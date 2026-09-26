import {
  DISPATCH_NAMESPACE,
  type DeliveryDto,
  type DispatchSession,
  type DriverLocationEvent,
  type TrackingLinkDto,
  type TrackingResponse,
  type TrackingView,
  type WebhookEnvelope,
} from '@dispatch/shared';
import { SignJWT, decodeJwt } from 'jose';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhook } from '../../src/outbox/webhook-signature.js';
import { TrackingTokens } from '../../src/tracking/tracking-tokens.js';
import {
  Api,
  WebhookSink,
  createDelivery,
  enrolDriver,
  eventually,
  fix,
  moveTo,
  proofForm,
  resetState,
  sendFixes,
  startApp,
  type TestApp,
} from '../support/harness.js';
import {
  collect,
  connectDispatch,
  connectTracking,
  connected,
  type DispatchSocket,
} from '../support/sockets.js';

const SECRET = 'e2e-webhook-secret-e2e-webhook-secret-0000';

/**
 * The core flow, end to end, through the public HTTP and WebSocket interfaces: a dispatcher
 * watches the live map, the nearest driver is assigned, the customer follows a tracking link,
 * the driver delivers with proof inside the geofence, and the order system receives signed
 * webhooks it can verify.
 */
describe('delivery flow (e2e)', () => {
  const sink = new WebhookSink();
  let t: TestApp;
  let dispatcher: Api;
  let liveMap: DispatchSocket;

  beforeAll(async () => {
    const url = await sink.start();
    t = await startApp({ WEBHOOK_URL: url, WEBHOOK_SECRET: SECRET }, { worker: true });
    await resetState(t.db, t.redis);
    dispatcher = await new Api(t.url).login();
    liveMap = await connectDispatch(t.url, dispatcher.token ?? '');
  });
  afterAll(async () => {
    liveMap.close();
    await t.close();
    await sink.stop();
  });

  it('runs from assignment to a verified delivery.completed webhook', async () => {
    const locations = collect<DriverLocationEvent>(liveMap, 'driver:location');
    const updates = collect<DeliveryDto>(liveMap, 'delivery:updated');

    // Two drivers on shift; the console's live map sees their positions.
    const omar = await enrolDriver(dispatcher, 'Omar Haddad');
    const sara = await enrolDriver(dispatcher, 'Sara Ali');
    await moveTo(omar, 25.1425, 55.2275);
    await moveTo(sara, 25.2, 55.28);
    await eventually(() => locations.length >= 2);
    expect(locations.map((e) => e.driverId).sort()).toEqual([omar.id, sara.id].sort());
    expect(locations[0]?.sentAt).toEqual(expect.any(Number));

    // The nearest free driver is assigned automatically.
    const delivery = await createDelivery(dispatcher, { autoAssign: true });
    expect(delivery.driver?.id).toBe(omar.id);
    await eventually(() => updates.some((u) => u.id === delivery.id && u.status === 'assigned'));

    // The customer opens the tracking link.
    const link = (
      await dispatcher.post<TrackingLinkDto>(`/v1/deliveries/${delivery.id}/tracking-link`, {})
    ).body;
    const page = await new Api(t.url).get<TrackingResponse>(`/v1/tracking/${link.token}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      status: 'assigned',
      driver: { firstName: 'Omar', position: null },
      eta: null,
    });
    const customer = await connected(connectTracking(t.url, link.token));
    const views = collect<TrackingView>(customer, 'tracking:update');
    await eventually(() => views.length >= 1);

    // Picked up: the customer now sees the driver's position and an ETA as the driver moves.
    await omar.api.post(`/v1/driver/deliveries/${delivery.id}/pickup`);
    await moveTo(omar, 25.12, 55.21);
    const moving = await eventually(() =>
      views.find((v) => v.status === 'picked_up' && v.driver?.position?.lat === 25.12),
    );
    expect(moving.driver?.position).toEqual({ lat: 25.12, lng: 55.21 });
    expect(moving.eta).toMatchObject({ source: 'straight_line' });
    expect(moving.eta?.seconds).toBeGreaterThan(0);

    // Delivered with a photo and signature, 100 m from the drop-off point.
    const completed = await fetch(`${t.url}/v1/driver/deliveries/${delivery.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${omar.api.token ?? ''}` },
      body: proofForm({ lat: 25.098, lng: 55.2019 }),
    });
    expect(completed.status).toBe(200);
    const done = await eventually(() => views.find((v) => v.status === 'delivered'));
    expect(done.driver?.position).toBeNull();
    expect(done.completedAt).not.toBeNull();

    // The order system received every event once, each verifiable with the shared secret.
    const events = await eventually(() => {
      const mine = sink.received.filter(
        (r) => (JSON.parse(r.body) as WebhookEnvelope).data.deliveryId === delivery.id,
      );
      return mine.length >= 3 ? mine : undefined;
    });
    const envelopes = events.map((r) => JSON.parse(r.body) as WebhookEnvelope);
    expect(envelopes.map((e) => e.type).sort()).toEqual([
      'delivery.assigned',
      'delivery.completed',
      'delivery.picked_up',
    ]);
    for (const received of events) {
      expect(
        verifyWebhook(SECRET, received.body, received.headers['x-dispatch-signature'] as string)
          .valid,
      ).toBe(true);
    }
    const completedEvent = envelopes.find((e) => e.type === 'delivery.completed');
    expect(completedEvent?.data).toMatchObject({
      orderReference: delivery.orderReference,
      status: 'delivered',
      driver: { id: omar.id, name: 'Omar Haddad' },
      proof: {
        recipientName: 'Aisha Rahman',
        withinGeofence: true,
        hasPhoto: true,
        hasSignature: true,
      },
    });
    customer.close();
  });

  it('lets a reconnecting console catch up on positions it missed', async () => {
    const driver = await enrolDriver(dispatcher, 'Yusuf Khan');
    const seen = collect<DriverLocationEvent>(liveMap, 'driver:location');
    await moveTo(driver, 25.2, 55.27);
    await eventually(() => seen.some((e) => e.driverId === driver.id));
    const cursor = seen.filter((e) => e.driverId === driver.id).at(-1)?.id ?? null;

    // The console is offline while the driver sends three more fixes.
    liveMap.disconnect();
    const missed = [
      fix(driver, 25.201, 55.271),
      fix(driver, 25.202, 55.272),
      fix(driver, 25.203, 55.273),
    ];
    await sendFixes(driver, missed);

    liveMap = await connectDispatch(t.url, dispatcher.token ?? '');
    const resumed = await liveMap.emitWithAck('resume', { since: cursor });
    expect(resumed.gap).toBe(false);
    expect(resumed.complete).toBe(true);
    expect(resumed.events.filter((e) => e.driverId === driver.id).map((e) => e.seq)).toEqual(
      missed.map((p) => p.seq),
    );
  });

  it('rejects sockets without valid credentials and expired tracking links', async () => {
    await expect(connectDispatch(t.url, 'forged')).rejects.toThrow('unauthorized');
    await expect(connected(connectTracking(t.url, 'v1.e30.AAAA'))).rejects.toThrow(/tracking link/);

    const delivery = await createDelivery(dispatcher);
    const expired = await new Api(t.url).get<{ code: string }>(
      `/v1/tracking/${signExpired(delivery.id)}`,
    );
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('TRACKING_LINK_EXPIRED');
    const tampered = await new Api(t.url).get(
      `/v1/tracking/${signExpired(delivery.id).replace('v1.', 'v1.x')}`,
    );
    expect(tampered.status).toBe(404);
  });

  it('tells a console which instance serves it and closes the connection when its session ends', async () => {
    // The same dispatcher, with a token that expires in two seconds.
    const claims = decodeJwt(dispatcher.token ?? '');
    const shortLived = await new SignJWT({ email: claims.email, name: claims.name })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub ?? '')
      .setIssuer('dispatch-api')
      .setAudience('dispatch-console')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(t.config.auth.jwtSecret));

    // Listeners go on before the connection opens: the server speaks first.
    const socket: DispatchSocket = io(`${t.url}${DISPATCH_NAMESPACE}`, {
      transports: ['websocket'],
      auth: { token: shortLived },
      reconnection: false,
      forceNew: true,
    });
    const sessions = collect<DispatchSession>(socket, 'session');
    const closed = new Promise<string>((resolve) => {
      socket.once('disconnect', resolve);
    });
    await connected(socket);
    await eventually(() => sessions.length === 1);
    expect(sessions[0]?.instanceId).toBe('test');
    expect(Date.parse(sessions[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(await closed).toBe('io server disconnect');
  });

  /** A link that expired a minute ago, signed with the test secret. */
  function signExpired(deliveryId: string): string {
    return t.app.get(TrackingTokens).sign(deliveryId, new Date(Date.now() - 60_000));
  }
});
