import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type {
  CreateDeliveryInput,
  DeliveryDto,
  EnrolDeviceResult,
  LocationBatchResult,
  LocationPoint,
} from '@dispatch/shared';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../src/app.module.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { configureApp } from '../../src/bootstrap.js';
import { APP_CONFIG } from '../../src/config/config.module.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { Database } from '../../src/db/database.js';
import { RedisService } from '../../src/redis/redis.service.js';
import { WorkerModule } from '../../src/worker.module.js';

export const DISPATCHER_EMAIL = 'dispatcher@test.local';
export const DISPATCHER_PASSWORD = 'correct horse battery staple';

/** A 1×1 PNG: the smallest real image the photo check accepts. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface TestApp {
  url: string;
  config: AppConfig;
  app: NestExpressApplication;
  worker: INestApplicationContext | null;
  db: Database;
  redis: RedisService;
  close(): Promise<void>;
}

/** Boots the real application (same middleware and adapter as production) on a random port. */
export async function startApp(
  overrides: Record<string, string> = {},
  options: { worker?: boolean; instanceId?: string } = {},
): Promise<TestApp> {
  const config = Object.freeze(
    loadConfig({ ...process.env, INSTANCE_ID: options.instanceId ?? 'test', ...overrides }),
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  configureApp(app, config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;

  let worker: INestApplicationContext | null = null;
  if (options.worker) {
    const workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    workerRef.useLogger(['error', 'warn']);
    worker = await workerRef.init();
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    config,
    app,
    worker,
    db: app.get(Database),
    redis: app.get(RedisService),
    async close() {
      await worker?.close();
      await app.close();
    },
  };
}

/** Empties every table (keeping the schema) and the test Redis database. */
export async function resetState(db: Database, redis: RedisService): Promise<void> {
  await db.query(
    `TRUNCATE outbox, proofs_of_delivery, delivery_events, deliveries, location_updates,
              enrolment_codes, devices, drivers, dispatchers RESTART IDENTITY CASCADE`,
  );
  await redis.client.flushdb();
  await db.query('INSERT INTO dispatchers (email, name, password_hash) VALUES ($1, $2, $3)', [
    DISPATCHER_EMAIL,
    'Test Dispatcher',
    await hashPassword(DISPATCHER_PASSWORD),
  ]);
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** A small fetch wrapper: JSON in, JSON out, bearer token optional. */
export class Api {
  constructor(
    readonly url: string,
    readonly token?: string,
  ) {}

  as(token: string): Api {
    return new Api(this.url, token);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${this.url}${path}`, { method, headers, body: payload });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as T,
      headers: response.headers,
    };
  }

  get<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body ?? {});
  }

  async login(): Promise<Api> {
    const res = await this.post<{ accessToken: string }>('/v1/auth/login', {
      email: DISPATCHER_EMAIL,
      password: DISPATCHER_PASSWORD,
    });
    if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
    return this.as(res.body.accessToken);
  }
}

export interface TestDriver {
  id: string;
  deviceId: string;
  api: Api;
  seq: number;
}

/** Creates a driver through the dispatcher API and enrols a device for it, like the app does. */
export async function enrolDriver(
  dispatcher: Api,
  name: string,
  onShift = true,
): Promise<TestDriver> {
  const created = await dispatcher.post<{ enrolment: { code: string } }>('/v1/drivers', { name });
  if (created.status !== 201)
    throw new Error(`Create driver failed: ${JSON.stringify(created.body)}`);
  const enrolled = await new Api(dispatcher.url).post<EnrolDeviceResult>('/v1/devices/enrol', {
    code: created.body.enrolment.code,
    deviceName: `${name}'s phone`,
  });
  if (enrolled.status !== 201) throw new Error(`Enrol failed: ${JSON.stringify(enrolled.body)}`);
  const driver: TestDriver = {
    id: enrolled.body.driver.id,
    deviceId: enrolled.body.deviceId,
    api: new Api(dispatcher.url, enrolled.body.deviceToken),
    seq: 0,
  };
  if (onShift) await driver.api.post('/v1/driver/shift', { onShift: true });
  return driver;
}

export function fix(
  driver: TestDriver,
  lat: number,
  lng: number,
  recordedAt = new Date(),
): LocationPoint {
  const point: LocationPoint = {
    seq: driver.seq,
    idempotencyKey: randomUUID(),
    recordedAt: recordedAt.toISOString(),
    lat,
    lng,
    accuracyM: 8,
  };
  driver.seq += 1;
  return point;
}

export async function sendFixes(
  driver: TestDriver,
  points: LocationPoint[],
): Promise<ApiResponse<LocationBatchResult>> {
  return driver.api.post<LocationBatchResult>('/v1/driver/locations', {
    points,
    sentAt: Date.now(),
  });
}

export async function moveTo(driver: TestDriver, lat: number, lng: number): Promise<void> {
  const res = await sendFixes(driver, [fix(driver, lat, lng)]);
  if (res.status !== 200) throw new Error(`Location failed: ${JSON.stringify(res.body)}`);
}

let orderCounter = 0;
export function deliveryInput(overrides: Partial<CreateDeliveryInput> = {}): CreateDeliveryInput {
  orderCounter += 1;
  return {
    orderReference: `TF-SO-2026-${String(900_000 + orderCounter)}-${randomUUID().slice(0, 4)}`,
    recipientName: 'Aisha Rahman',
    recipientPhone: '+971 50 123 4567',
    address: 'Villa 12, Street 4, Al Barsha 2, Dubai',
    // Pickup: Al Quoz industrial area. Drop-off: Al Barsha 2.
    pickup: { lat: 25.1415, lng: 55.2263 },
    dropoff: { lat: 25.0971, lng: 55.2019 },
    autoAssign: false,
    ...overrides,
  };
}

export async function createDelivery(
  dispatcher: Api,
  overrides: Partial<CreateDeliveryInput> = {},
): Promise<DeliveryDto> {
  const res = await dispatcher.post<DeliveryDto>('/v1/deliveries', deliveryInput(overrides));
  if (res.status !== 201) throw new Error(`Create delivery failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export const SIGNATURE = { width: 300, height: 120, strokes: [[10, 60, 60, 20, 120, 90, 200, 30]] };

export function proofForm(
  position: { lat: number; lng: number },
  accuracyM = 6,
  photo = PNG_1X1,
  capturedAt = new Date(),
): FormData {
  const form = new FormData();
  form.set(
    'proof',
    JSON.stringify({
      recipientName: 'Aisha Rahman',
      position,
      accuracyM,
      capturedAt: capturedAt.toISOString(),
      signature: SIGNATURE,
    }),
  );
  form.set('photo', new Blob([new Uint8Array(photo)], { type: 'image/png' }), 'parcel.png');
  return form;
}

export interface ReceivedWebhook {
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local HTTP endpoint standing in for the order system; its answers can be scripted. */
export class WebhookSink {
  readonly received: ReceivedWebhook[] = [];
  private readonly server: Server;
  private statuses: number[] = [];
  url = '';

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.received.push({
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.statusCode = this.statuses.shift() ?? 200;
        response.end(response.statusCode < 300 ? '{"status":"ok"}' : '{"error":"scripted"}');
      });
    });
  }

  /** The next responses, in order; afterwards the sink answers 200. */
  respondWith(...statuses: number[]): void {
    this.statuses = statuses;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(address.port)}/integrations/dispatch/events`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }
}

/** Polls until `check` returns a value (not undefined/false) or the timeout passes. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: Error | undefined;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Condition not met within ${String(timeoutMs)} ms${last ? `: ${last.message}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
