import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { WorkerModule } from './worker.module.js';

// Validate the environment before anything connects, so a bad deployment stops with a list of
// what is wrong rather than a stack trace from the first query.
let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const logger = new Logger('Bootstrap');
if (config.exampleSecretsAllowed.length > 0) {
  logger.warn(
    `ALLOW_INSECURE_LOCAL_SECRETS is on: ${config.exampleSecretsAllowed.join(', ')} ` +
      'use published example values. Anyone can forge sessions or tracking links with them; ' +
      'use this only for a stack on your own machine.',
  );
}

if (config.role === 'api' || config.role === 'all') {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, config);
  await app.listen(config.port, '0.0.0.0');
  logger.log(`API ${config.instanceId} listening on :${String(config.port)} (${config.env})`);
}

if (config.role === 'worker' || config.role === 'all') {
  const worker = await NestFactory.createApplicationContext(WorkerModule);
  worker.enableShutdownHooks();
  logger.log(`Worker ${config.instanceId} started`);
}
