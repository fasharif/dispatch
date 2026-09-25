#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiClient } from './api-client.js';
import { demo } from './demo.js';
import { drive } from './drive.js';
import { readFleet, seedFleet, writeFleet } from './fleet.js';
import { listen, type ListenReport } from './listen.js';
import { verify } from './verify.js';

const USAGE = `dispatch-sim <command> [options]

Commands
  seed     Create drivers, enrol one simulated phone each and write a fleet file
  drive    Move a fleet along routes around Dubai and send a fix every interval
  demo     Seed drivers and run deliveries end to end (orders, pickup, proof of delivery)
  listen   Connect as a dispatcher console and record which fixes arrive, and how late
  verify   Compare a listen report with the database: every stored fix must have arrived

Common options
  --api <url>            API origin (default http://localhost:57100, env DISPATCH_API)
  --email, --password    Dispatcher account (env DISPATCH_EMAIL, DISPATCH_PASSWORD)
  --fleet <file>         Fleet file (default fleet.json)

seed      --drivers <n> [--prefix <name>]
drive     [--interval <s>=3] [--duration <s>=60] [--offline-rate <0-1>=0.02] [--offline-seconds <s>=20]
demo      [--drivers <n>=12] [--interval <s>=2] [--duration <s>=600] [--order-every <s>=20]
listen    [--duration <s>=60] [--out <file>=listen-report.json]
verify    --report <file> --database-url <url>
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: process.env.DISPATCH_API ?? 'http://localhost:57100' },
    email: { type: 'string', default: process.env.DISPATCH_EMAIL ?? 'dispatcher@dispatch.local' },
    password: { type: 'string', default: process.env.DISPATCH_PASSWORD ?? 'dispatch-demo-2026' },
    fleet: { type: 'string', default: 'fleet.json' },
    drivers: { type: 'string' },
    prefix: { type: 'string', default: 'Sim Driver' },
    interval: { type: 'string' },
    duration: { type: 'string' },
    'offline-rate': { type: 'string', default: '0.02' },
    'offline-seconds': { type: 'string', default: '20' },
    'order-every': { type: 'string', default: '20' },
    out: { type: 'string', default: 'listen-report.json' },
    report: { type: 'string' },
    'database-url': { type: 'string', default: process.env.DATABASE_URL },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (line: string) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
};

function number(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`--${name} must be a non-negative number`);
  return parsed;
}

async function dispatcherToken(api: string): Promise<string> {
  const { accessToken } = await new ApiClient(api).login(values.email, values.password);
  return accessToken;
}

async function main(): Promise<number> {
  const [command] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  switch (command) {
    case 'seed': {
      const drivers = number(values.drivers, 10, 'drivers');
      const fleet = await seedFleet({
        api: values.api,
        email: values.email,
        password: values.password,
        drivers,
        prefix: values.prefix,
      });
      await writeFleet(values.fleet, fleet);
      log(`Enrolled ${String(fleet.drivers.length)} drivers; fleet written to ${values.fleet}`);
      return 0;
    }
    case 'drive': {
      const fleet = await readFleet(values.fleet);
      const summary = await drive(fleet, {
        intervalSeconds: number(values.interval, 3, 'interval'),
        durationSeconds: number(values.duration, 60, 'duration'),
        offlineRate: number(values['offline-rate'], 0.02, 'offline-rate'),
        offlineSeconds: number(values['offline-seconds'], 20, 'offline-seconds'),
        log,
      });
      log(`Done: ${JSON.stringify(summary)}`);
      return summary.stillQueued === 0 ? 0 : 1;
    }
    case 'demo': {
      const fleet = await seedFleet({
        api: values.api,
        email: values.email,
        password: values.password,
        drivers: number(values.drivers, 12, 'drivers'),
        prefix: values.prefix === 'Sim Driver' ? 'Demo Driver' : values.prefix,
      });
      log(`Enrolled ${String(fleet.drivers.length)} demo drivers`);
      await demo(fleet, {
        dispatcher: new ApiClient(values.api).withToken(await dispatcherToken(values.api)),
        intervalSeconds: number(values.interval, 2, 'interval'),
        durationSeconds: number(values.duration, 600, 'duration'),
        newDeliveryEverySeconds: number(values['order-every'], 20, 'order-every'),
        log,
      });
      return 0;
    }
    case 'listen': {
      const report = await listen({
        api: values.api,
        token: await dispatcherToken(values.api),
        durationSeconds: number(values.duration, 60, 'duration'),
        log,
      });
      await writeFile(values.out, `${JSON.stringify(report)}\n`);
      const { receivedKeys: _keys, ...summary } = report;
      log(`Report written to ${values.out}: ${JSON.stringify(summary)}`);
      return 0;
    }
    case 'verify': {
      if (!values.report || !values['database-url'])
        throw new Error('verify needs --report and --database-url');
      const report = JSON.parse(await readFile(values.report, 'utf8')) as ListenReport;
      const result = await verify(values['database-url'], await readFleet(values.fleet), report);
      log(JSON.stringify(result));
      return result.lost === 0 && result.unexpected === 0 ? 0 : 1;
    }
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
