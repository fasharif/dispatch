import 'reflect-metadata';
import { inject } from 'vitest';
import { testEnv } from './test-env.js';

// Runs before every integration and e2e test file, with the targets prepared by global-setup.ts.
Object.assign(process.env, testEnv({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') }));
