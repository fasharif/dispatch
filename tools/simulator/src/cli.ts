#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiClient } from './api-client.js';
import { demo } from './demo.js';
import { drive } from './drive.js';
import { demoDriverName, numberedNames, readFleet, seedFleet, writeFleet } from './fleet.js';
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

seed      --drivers <n> [--prefix <name>=Sim Driver]
drive     [--interval <s>=3] [--duration <s>=60] [--offline-rate <0-1>=0.02] [--offline-seconds <s>=20]
demo      [--drivers <n>=12] [--interval <s>=2] [--duration <s>=600] [--order-every <s>=40] [--prefix <name>]

seed and demo reuse drivers that already exist under the same name, so running them again
does not create duplicates. demo also keeps the phones it enrolled in the fleet file (device
tokens: keep it private) and reuses them on the next run while they work.
listen    [--duration <s>=60] [--out <file>=listen-report.json]
verify    --report <file> --database-url <url> [--result <file>]
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: process.env.DISPATCH_API ?? 'http://localhost:57100' },
    email: { type: 'string', default: process.env.DISPATCH_EMAIL ?? 'dispatcher@dispatch.local' },
    password: { type: 'string', default: process.env.DISPATCH_PASSWORD ?? 'dispatch-demo-2026' },
    fleet: { type: 'string', default: 'fleet.json' },
    drivers: { type: 'string' },
    prefix: { type: 'string' },
    interval: { type: 'string' },
    duration: { type: 'string' },
    'offline-rate': { type: 'string', default: '0.02' },
    'offline-seconds': { type: 'string', default: '20' },
    'order-every': { type: 'string', default: '40' },
    out: { type: 'string', default: 'listen-report.json' },
    report: { type: 'string' },
    result: { type: 'string' },
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
        name: numberedNames(values.prefix ?? 'Sim Driver'),
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
      // The phones of an earlier run are kept in the fleet file and reused while they work.
      const earlier = await readFleet(values.fleet).catch(() => null);
      const fleet = await seedFleet({
        api: values.api,
        email: values.email,
        password: values.password,
        drivers: number(values.drivers, 12, 'drivers'),
        name: values.prefix ? numberedNames(values.prefix) : demoDriverName,
        reuse: earlier,
      });
      await writeFleet(values.fleet, fleet);
      const kept = fleet.drivers.filter((d) =>
        earlier?.drivers.some((e) => e.deviceId === d.deviceId),
      ).length;
      log(
        `${String(fleet.drivers.length)} demo drivers on shift ` +
          `(${String(kept)} with the phone from the last run); fleet file ${values.fleet}`,
      );
      await demo(fleet, {
        dispatcher: new ApiClient(values.api).withToken(await dispatcherToken(values.api)),
        intervalSeconds: number(values.interval, 2, 'interval'),
        durationSeconds: number(values.duration, 600, 'duration'),
        newDeliveryEverySeconds: number(values['order-every'], 40, 'order-every'),
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
      if (values.result) await writeFile(values.result, `${JSON.stringify(result, null, 2)}\n`);
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
