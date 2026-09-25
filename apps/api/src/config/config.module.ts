import { Global, Inject, Module } from '@nestjs/common';
import { loadConfig } from './env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Injects the validated, frozen AppConfig. */
export const InjectConfig = (): ParameterDecorator => Inject(APP_CONFIG);

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => Object.freeze(loadConfig()) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
