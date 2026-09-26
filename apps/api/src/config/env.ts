import { DEFAULT_DRIVER_STALE_AFTER_S } from '@dispatch/shared';
import { hostname } from 'node:os';
import { z } from 'zod';

/**
 * Environment contract, validated once at start-up. A misconfigured process stops with a readable
 * list of problems instead of failing later on the first request that needs the missing value.
 */
const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const required = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const secret = (name: string) =>
  z
    .string({ error: `${name} is required (32+ random characters: openssl rand -base64 48)` })
    .min(32, `${name} must be at least 32 characters (for example: openssl rand -base64 48)`);

/** Values from .env.example and docker-compose.yml. They are public, so production refuses them. */
const PUBLIC_EXAMPLE_SECRET = /change-me|example|local-only/i;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /** api: HTTP and WebSockets. worker: background jobs. all: both, for development. */
    PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    INSTANCE_ID: z.string().min(1).max(64).default(hostname()),

    DATABASE_URL: required('DATABASE_URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: required('REDIS_URL'),

    JWT_SECRET: secret('JWT_SECRET'),
    JWT_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(8 * 60),
    TRACKING_TOKEN_SECRET: secret('TRACKING_TOKEN_SECRET'),
    TRACKING_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),
    /** Origin of the web app; tracking links point at `${PUBLIC_WEB_URL}/track/<token>`. */
    PUBLIC_WEB_URL: z.url().default('http://localhost:57300'),
    /** Accept the example secrets in production mode (the local Docker stack only). */
    ALLOW_INSECURE_LOCAL_SECRETS: booleanFlag.default(false),

    CORS_ORIGINS: csv.default(['http://localhost:57300']),
    TRUST_PROXY: booleanFlag.default(false),
    THROTTLE_LIMIT: z.coerce.number().int().min(1).default(600),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().min(1).default(10),
    /** Invalid device tokens per client address and minute before the address is refused. */
    AUTH_FAILURE_LIMIT: z.coerce.number().int().min(1).default(30),

    UPLOAD_DIR: z.string().min(1).default('./data/uploads'),
    MAX_PHOTO_BYTES: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(25 * 1024 * 1024)
      .default(8 * 1024 * 1024),

    GEOFENCE_RADIUS_M: z.coerce.number().int().min(10).max(2_000).default(150),
    /** Reported GPS accuracy widens the fence by up to this many metres. */
    GEOFENCE_ACCURACY_ALLOWANCE_M: z.coerce.number().int().min(0).max(500).default(50),
    /** Drivers without a fix for longer than this are not auto-assigned. */
    DRIVER_STALE_AFTER_S: z.coerce
      .number()
      .int()
      .min(10)
      .max(3_600)
      .default(DEFAULT_DRIVER_STALE_AFTER_S),
    /** Rejects fixes stamped this far in the future (device clock skew). */
    MAX_CLOCK_SKEW_S: z.coerce.number().int().min(0).max(3_600).default(120),

    LOCATION_STREAM_RETENTION_MIN: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),
    LOCATION_HISTORY_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),

    WEBHOOK_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    WEBHOOK_SECRET: z
      .string()
      .optional()
      .transform((value) => (value === '' ? undefined : value)),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
    WEBHOOK_BACKOFF_MS: z.coerce.number().int().min(100).max(600_000).default(2_000),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

    OSRM_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    OSRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1_500),
    ETA_SPEED_KMH: z.coerce.number().min(5).max(120).default(30),
    ETA_DETOUR_FACTOR: z.coerce.number().min(1).max(3).default(1.4),
  })
  .superRefine((env, ctx) => {
    if (env.WEBHOOK_URL && (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 32)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: 'WEBHOOK_SECRET is required with WEBHOOK_URL and must be at least 32 characters',
      });
    }
    if (env.NODE_ENV !== 'production' || env.ALLOW_INSECURE_LOCAL_SECRETS) return;
    for (const key of exampleSecrets(env)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is a published example value; generate a new secret for production`,
      });
    }
  });

const SECRET_KEYS = ['JWT_SECRET', 'TRACKING_TOKEN_SECRET', 'WEBHOOK_SECRET'] as const;

/** The secrets that hold one of the published example values. */
function exampleSecrets(
  env: Partial<Record<(typeof SECRET_KEYS)[number], string | undefined>>,
): (typeof SECRET_KEYS)[number][] {
  return SECRET_KEYS.filter((key) => {
    const value = env[key];
    return value !== undefined && PUBLIC_EXAMPLE_SECRET.test(value);
  });
}

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  /**
   * Published example secrets accepted in production because ALLOW_INSECURE_LOCAL_SECRETS is on
   * (the compose stack on one's own machine). The process logs a warning naming them.
   */
  exampleSecretsAllowed: string[];
  port: number;
  role: Env['PROCESS_ROLE'];
  instanceId: string;
  database: { url: string; poolMax: number };
  redisUrl: string;
  auth: { jwtSecret: string; jwtTtlMinutes: number };
  tracking: { secret: string; ttlHours: number; publicWebUrl: string };
  http: {
    corsOrigins: string[];
    trustProxy: boolean;
    throttleLimit: number;
    authThrottleLimit: number;
    authFailureLimit: number;
  };
  uploads: { dir: string; maxPhotoBytes: number };
  geofence: { radiusM: number; accuracyAllowanceM: number };
  drivers: { staleAfterS: number; maxClockSkewS: number };
  locations: { streamRetentionMin: number; historyDays: number };
  webhooks: {
    url?: string;
    secret?: string;
    maxAttempts: number;
    backoffMs: number;
    timeoutMs: number;
  };
  eta: { osrmUrl?: string; osrmTimeoutMs: number; speedKmh: number; detourFactor: number };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    exampleSecretsAllowed:
      env.NODE_ENV === 'production' && env.ALLOW_INSECURE_LOCAL_SECRETS ? exampleSecrets(env) : [],
    port: env.PORT,
    role: env.PROCESS_ROLE,
    instanceId: env.INSTANCE_ID,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    redisUrl: env.REDIS_URL,
    auth: { jwtSecret: env.JWT_SECRET, jwtTtlMinutes: env.JWT_TTL_MINUTES },
    tracking: {
      secret: env.TRACKING_TOKEN_SECRET,
      ttlHours: env.TRACKING_LINK_TTL_HOURS,
      publicWebUrl: env.PUBLIC_WEB_URL.replace(/\/+$/, ''),
    },
    http: {
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      throttleLimit: env.THROTTLE_LIMIT,
      authThrottleLimit: env.AUTH_THROTTLE_LIMIT,
      authFailureLimit: env.AUTH_FAILURE_LIMIT,
    },
    uploads: { dir: env.UPLOAD_DIR, maxPhotoBytes: env.MAX_PHOTO_BYTES },
    geofence: {
      radiusM: env.GEOFENCE_RADIUS_M,
      accuracyAllowanceM: env.GEOFENCE_ACCURACY_ALLOWANCE_M,
    },
    drivers: { staleAfterS: env.DRIVER_STALE_AFTER_S, maxClockSkewS: env.MAX_CLOCK_SKEW_S },
    locations: {
      streamRetentionMin: env.LOCATION_STREAM_RETENTION_MIN,
      historyDays: env.LOCATION_HISTORY_DAYS,
    },
    webhooks: {
      url: env.WEBHOOK_URL,
      secret: env.WEBHOOK_SECRET,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      backoffMs: env.WEBHOOK_BACKOFF_MS,
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
    },
    eta: {
      osrmUrl: env.OSRM_URL?.replace(/\/+$/, ''),
      osrmTimeoutMs: env.OSRM_TIMEOUT_MS,
      speedKmh: env.ETA_SPEED_KMH,
      detourFactor: env.ETA_DETOUR_FACTOR,
    },
  };
}
