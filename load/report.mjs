// Summarises one scale-test run (load/results/<run>/) as Markdown.
//
//   node load/report.mjs load/results/<run>                    print and write summary.md
//   node load/report.mjs load/results/<run> --docs             also record the run in docs/
//   node load/report.mjs load/results/<run> --docs --publish-timings
//
// Counts (fixes stored, received, lost) are always reported. Latency and CPU use are reported only
// with --publish-timings: runs on a busy development machine are functional checks, and their
// timings would mislead. The quiet-machine run passes the flag.
//
// --docs adds (or replaces) the run's row in docs/scale-test.md and writes the counts behind it to
// docs/scale-runs/<run>.json (with latency percentiles and resource use when they are published),
// so every published row can be checked. The raw results folder is not committed: its fleet file
// holds device tokens.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: node load/report.mjs <results dir> [--docs] [--publish-timings]');
  process.exit(2);
}
const publishTimings = flags.includes('--publish-timings');
const readJson = async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'));

const run = await readJson('run.json');
const k6 = await readJson('k6-summary.json');
const consoles = {
  reconnecting: {
    listen: await readJson('listen-lb.json'),
    verify: await readJson('verify-lb.json'),
  },
  surviving: {
    listen: await readJson('listen-survivor.json'),
    verify: await readJson('verify-survivor.json'),
  },
};
const { reconnecting, surviving } = consoles;

const NOT_PUBLISHED = 'not published (shared machine)';
const round = (value) =>
  value === null || value === undefined ? 'n/a' : String(Math.round(value));
/** "p50 / p95 / p99 ms" of a listener's latency summary. */
const percentiles = (summary) =>
  summary && summary.count > 0
    ? `${round(summary.p50)} / ${round(summary.p95)} / ${round(summary.p99)} ms`
    : 'n/a';
const timing = (summary) => (publishTimings ? percentiles(summary) : NOT_PUBLISHED);
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const mib = (bytes) => `${Math.round(bytes / 1024 ** 2)} MiB`;
// Runs before the compose names followed the project recorded "dispatch-api-2".
const killed = run.killedInstance.replace(/^dispatch-/, '');
const survivor = run.survivingInstance.replace(/^dispatch-/, '');
const replayed = k6.fixesDuplicate + k6.batchRetries;

const environment = `${run.host.os}, Docker ${run.host.dockerServerVersion}, ${run.host.dockerCpus} CPUs, ${gib(run.host.dockerMemoryBytes)}${run.databasePoolMax ? `; ${run.databasePoolMax} DB connections per API` : ''}; commit ${run.gitCommit}`;

// Resource use, from the `docker stats` samples (stats.jsonl; runs before it existed have none).
const SERVICES = {
  'api-1': 'api-1',
  'api-2': 'api-2',
  worker: 'worker',
  nginx: 'nginx',
  postgres: 'postgres',
  redis: 'redis',
  k6: 'k6 (drivers)',
  'listener-lb': 'console A (listener)',
  'listener-survivor': 'console B (listener)',
};
const UNITS = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};
const bytes = (text) => {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  return match ? Number(match[1]) * (UNITS[match[2]] ?? Number.NaN) : Number.NaN;
};
const mean = (values) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
const peak = (values) => (values.length === 0 ? null : values.reduce((a, b) => Math.max(a, b)));

async function resourceUse() {
  let text;
  try {
    text = await readFile(join(dir, 'stats.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const prefix = `${run.project ?? 'dispatch'}-`;
  const start = Date.parse(run.loadStartedAt);
  const kill = Date.parse(run.killedAt);
  const end = Date.parse(run.k6EndedAt);
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (!sample.Name?.startsWith(prefix)) continue;
    // Compose names end in the replica number ("api-1-1"); the harness's containers do not.
    const service = sample.Name.slice(prefix.length).replace(
      /^(api-\d|worker|nginx|postgres|redis)-\d+$/,
      '$1',
    );
    if (!(service in SERVICES)) continue;
    const [used = '', limit = ''] = sample.MemUsage.split(' / ');
    samples.push({
      at: Date.parse(sample.at),
      service,
      cpu: Number.parseFloat(sample.CPUPerc),
      memory: bytes(used),
      limit: bytes(limit),
    });
  }
  if (samples.length === 0) return null;
  const during = (s) => s.at >= start && s.at <= end;
  const summarise = (list) => ({
    samples: list.length,
    cpuMeanBeforeKillPct: mean(list.filter((s) => during(s) && s.at < kill).map((s) => s.cpu)),
    cpuMeanAfterKillPct: mean(list.filter((s) => during(s) && s.at >= kill).map((s) => s.cpu)),
    cpuPeakPct: peak(list.filter(during).map((s) => s.cpu)),
    memoryPeakBytes: peak(list.map((s) => s.memory)),
    memoryLimitBytes: peak(list.map((s) => s.limit)),
  });
  const containers = Object.fromEntries(
    Object.keys(SERVICES)
      .map((service) => [service, samples.filter((s) => s.service === service)])
      .filter(([, list]) => list.length > 0)
      .map(([service, list]) => [service, summarise(list)]),
  );
  // All containers together, per sampling round (one `docker stats` call shares one timestamp).
  const rounds = new Map();
  for (const s of samples) {
    const total = rounds.get(s.at) ?? { at: s.at, cpu: 0, memory: 0, limit: 0 };
    total.cpu += s.cpu;
    total.memory += s.memory;
    total.limit += s.limit;
    rounds.set(s.at, total);
  }
  return {
    everySeconds: run.statsEverySeconds,
    containers,
    total: summarise([...rounds.values()]),
  };
}
const resources = await resourceUse();

const row = [
  `[${run.run}](scale-runs/${run.run}.json)`,
  run.drivers,
  `${run.durationSeconds} s`,
  `${run.intervalSeconds} s`,
  `${killed} (SIGKILL, mid-run)`,
  reconnecting.verify.storedFixes,
  reconnecting.verify.receivedFixes,
  surviving.verify.receivedFixes,
  `${reconnecting.verify.lost} / ${surviving.verify.lost}`,
  reconnecting.listen.resumes,
  replayed,
  `${k6.fixesRefused} / ${k6.fixesUnacknowledged}`,
  timing(reconnecting.listen.latencyAllMs),
  timing(surviving.listen.latencyLiveMs),
  environment,
];

const consoleLine = (name, { listen, verify }, where) =>
  `| Console ${name} (${where}) | received ${verify.receivedFixes}, lost **${verify.lost}**; connections ${listen.connects} (${listen.instances.join(' → ') || 'none reported'}), resumes ${listen.resumes}, recovered by resume ${listen.resumedEvents} |`;

const latencyRow = (label, summary) =>
  summary
    ? `| ${label} | ${summary.count} | ${round(summary.p50)} | ${round(summary.p95)} | ${round(summary.p99)} | ${round(summary.max)} |`
    : `| ${label} | not recorded by this version of the listener | | | | |`;
const http = k6.httpDurationMs ?? {};
const latencySection = publishTimings
  ? `
## Latency (ms)

Driver to console: from the \`sentAt\` of the batch that stored the fix to its arrival at the
console, unless stated otherwise. "From recordedAt" starts when k6 recorded the fix, so it also
counts the time a batch spent being retried.

| Measure | Fixes | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
${latencyRow('Console A, all fixes (live and recovered by resume)', reconnecting.listen.latencyAllMs)}
${latencyRow('Console A, live fixes only', reconnecting.listen.latencyLiveMs)}
${latencyRow('Console A, all fixes, from recordedAt', reconnecting.listen.latencyFromRecordedMs)}
${latencyRow('Console B, live fixes', surviving.listen.latencyLiveMs)}
${latencyRow('Console B, all fixes, from recordedAt', surviving.listen.latencyFromRecordedMs)}
| k6: \`POST /v1/driver/locations\` until the answer (all attempts) | ${k6.httpRequests} requests | ${round(http['p(50)'])} | ${round(http['p(95)'])} | ${round(http['p(99)'])} | ${round(http.max)} |
`
  : `
Latency and CPU use: ${NOT_PUBLISHED}; they are in the run's listen-*.json, k6-summary.json and
stats.jsonl.
`;

// Latency by phase and over time, from the listeners' raw samples ([sentAt, latency] pairs; runs
// before the listener kept them have none). Percentiles use the nearest-rank method, as stats.ts.
const AFTER_KILL_MS = 30_000;
const WINDOW_MS = 30_000;
const summariseValues = (values) => {
  const sorted = Float64Array.from(values).sort();
  const rank = (p) =>
    sorted.length === 0 ? null : sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];
  return {
    count: sorted.length,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
};
const loadStart = Date.parse(run.loadStartedAt);
const killAt = Date.parse(run.killedAt);
const PHASES = [
  ['Before the kill', (t) => t < killAt],
  [
    `First ${AFTER_KILL_MS / 1000} s after the kill`,
    (t) => t >= killAt && t < killAt + AFTER_KILL_MS,
  ],
  [`From ${AFTER_KILL_MS / 1000} s after the kill to the end`, (t) => t >= killAt + AFTER_KILL_MS],
];
const phases = (listen) =>
  listen.samples
    ? PHASES.map(([phase, inPhase]) => ({
        phase,
        ...summariseValues(
          listen.samples.filter(([sentAt]) => inPhase(sentAt)).map(([, ms]) => ms),
        ),
      }))
    : null;
const timeline = (listen) => {
  if (!listen.samples || Number.isNaN(loadStart)) return null;
  const windows = new Map();
  for (const [sentAt, ms] of listen.samples) {
    const index = Math.max(0, Math.floor((sentAt - loadStart) / WINDOW_MS));
    const values = windows.get(index);
    if (values) values.push(ms);
    else windows.set(index, [ms]);
  }
  return [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, values]) => ({
      fromSecond: (index * WINDOW_MS) / 1000,
      ...summariseValues(values),
    }));
};
const latencyByPhase = {
  consoleA: phases(reconnecting.listen),
  consoleB: phases(surviving.listen),
};
const latencyTimeline = {
  consoleA: timeline(reconnecting.listen),
  consoleB: timeline(surviving.listen),
};
const cells = (s) =>
  s
    ? `${s.count} | ${round(s.p50)} | ${round(s.p95)} | ${round(s.p99)} | ${round(s.max)}`
    : 'n/a | | | |';
const phaseSection =
  publishTimings && latencyByPhase.consoleA && latencyByPhase.consoleB
    ? `
### By phase (all fixes, ms; phases by the batch's sentAt, kill at ${run.killedAt})

| Phase | A: fixes | A: p50 | A: p95 | A: p99 | A: max | B: fixes | B: p50 | B: p95 | B: p99 | B: max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${latencyByPhase.consoleA.map((a, i) => `| ${a.phase} | ${cells(a)} | ${cells(latencyByPhase.consoleB[i])} |`).join('\n')}

### Over time (all fixes, ms; ${WINDOW_MS / 1000}-second windows from the first stored fix)

| From | A: fixes | A: p50 | A: p95 | A: p99 | A: max | B: fixes | B: p50 | B: p95 | B: p99 | B: max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${latencyTimeline.consoleA
  .map((a) => {
    const b = latencyTimeline.consoleB.find((w) => w.fromSecond === a.fromSecond);
    const kill =
      killAt >= loadStart + a.fromSecond * 1000 &&
      killAt < loadStart + a.fromSecond * 1000 + WINDOW_MS;
    return `| ${a.fromSecond} s${kill ? ' (kill)' : ''} | ${cells(a)} | ${cells(b)} |`;
  })
  .join('\n')}
`
    : '';

const pct = (value) => (value === null ? 'n/a' : `${value.toFixed(0)} %`);
const resourceRow = (label, r) =>
  `| ${label} | ${mib(r.memoryLimitBytes)} | ${mib(r.memoryPeakBytes)} | ${pct(r.cpuMeanBeforeKillPct)} | ${pct(r.cpuMeanAfterKillPct)} | ${pct(r.cpuPeakPct)} |`;
const resourceSection =
  publishTimings && resources
    ? `
## Resource use

From \`docker stats\`, one sample of every container about every ${resources.everySeconds + 2} s
(${resources.everySeconds} s apart, plus about 2 s per sample). CPU is in percent of one CPU;
the means cover the load from the first stored fix to the end of k6, split at the kill. Peak
memory covers the whole sampled period.

| Container | Memory limit | Peak memory | CPU mean before kill | CPU mean after kill | CPU peak |
| --- | --- | --- | --- | --- | --- |
${Object.entries(resources.containers)
  .map(([service, r]) => resourceRow(SERVICES[service], r))
  .join('\n')}
${resourceRow('**All of the above**', resources.total)}
`
    : '';

const host = run.host;
const summary = `# Scale test ${run.run}

| | |
| --- | --- |
| Drivers (k6 virtual users) | ${run.drivers}, one fix every ${run.intervalSeconds} s for ${run.durationSeconds} s |
| API instances | 2 behind nginx, Socket.IO Redis adapter${run.databasePoolMax ? `, ${run.databasePoolMax} database connections each` : ''}; ${killed} killed with SIGKILL at ${run.killedAt}${run.loadStartedAt ? ` (first fix stored at ${run.loadStartedAt})` : ''}${run.killedInstanceStartedAgainAt ? `; **${killed} was started again at ${run.killedInstanceStartedAgainAt}, not by the harness**` : ''} |
| Fixes recorded by k6 | ${k6.fixesRecorded} (accepted ${k6.fixesAccepted}, duplicate ${k6.fixesDuplicate}, refused ${k6.fixesRefused}, unacknowledged ${k6.fixesUnacknowledged}) |
| Batch retries (k6) | ${k6.batchRetries}; batches that failed six attempts ${k6.batchesFailed}; replayed batches in total: ${replayed} |
| HTTP requests (k6) | ${k6.httpRequests}, failed ${(k6.httpFailedRate * 100).toFixed(3)} % |
| Fixes stored (database) | ${reconnecting.verify.storedFixes} |
${consoleLine('A', reconnecting, `through nginx, on the killed instance ${killed}`)}
${consoleLine('B', surviving, `connected to ${survivor} directly`)}
| **Lost events** | **${reconnecting.verify.lost + surviving.verify.lost}** |
| Environment | ${host.os}${host.dockerPlatform ? `, ${host.dockerPlatform}` : ''}, Docker ${host.dockerServerVersion} with ${host.dockerCpus} CPUs and ${gib(host.dockerMemoryBytes)} shared by all containers${host.cpuModel ? `; ${host.cpuModel}` : ''}; commit ${run.gitCommit} |
${latencySection}${phaseSection}${resourceSection}`;

await writeFile(join(dir, 'summary.md'), summary);
console.log(summary);

if (flags.includes('--docs')) {
  // Written the way Prettier formats the rest of the docs (npm run format:check). Loaded only
  // here: the scale test itself runs without the workspace's packages (CI's smoke job).
  const prettier = await import('prettier');
  const formatted = async (text, file) =>
    prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });

  const consoleCounts = ({ listen, verify }) => ({
    received: verify.receivedFixes,
    lost: verify.lost,
    connects: listen.connects,
    disconnects: listen.disconnects,
    resumes: listen.resumes,
    recoveredByResume: listen.resumedEvents,
    instances: listen.instances,
  });
  const latencies = ({ listen }) => ({
    allFixes: listen.latencyAllMs,
    liveFixes: listen.latencyLiveMs,
    ...(listen.latencyFromRecordedMs && { allFixesFromRecordedAt: listen.latencyFromRecordedMs }),
  });
  // Counts only, unless timings are published: no device tokens or ids, ever.
  const record = {
    run: run.run,
    gitCommit: run.gitCommit,
    drivers: run.drivers,
    durationSeconds: run.durationSeconds,
    intervalSeconds: run.intervalSeconds,
    killedInstance: killed,
    survivingInstance: survivor,
    ...(run.loadStartedAt && { loadStartedAt: run.loadStartedAt }),
    killedAt: run.killedAt,
    ...(run.databasePoolMax && { databasePoolMaxPerInstance: Number(run.databasePoolMax) }),
    ...(run.killedInstanceStartedAgainAt !== undefined && {
      killedInstanceStartedAgainAt: run.killedInstanceStartedAgainAt || null,
    }),
    ...(run.k6EndedAt && { k6EndedAt: run.k6EndedAt }),
    k6: {
      fixesRecorded: k6.fixesRecorded,
      fixesAccepted: k6.fixesAccepted,
      fixesDuplicate: k6.fixesDuplicate,
      fixesRefused: k6.fixesRefused,
      fixesUnacknowledged: k6.fixesUnacknowledged,
      batchRetries: k6.batchRetries,
      batchesFailed: k6.batchesFailed,
      httpRequests: k6.httpRequests,
    },
    storedFixes: reconnecting.verify.storedFixes,
    consoleA: consoleCounts(reconnecting),
    consoleB: consoleCounts(surviving),
    latencyMs: publishTimings
      ? {
          consoleA: latencies(reconnecting),
          consoleB: latencies(surviving),
          k6LocationRequests: k6.httpDurationMs,
          ...(latencyByPhase.consoleA && { byPhase: latencyByPhase }),
          ...(latencyTimeline.consoleA && {
            timelineWindowSeconds: WINDOW_MS / 1000,
            timeline: latencyTimeline,
          }),
        }
      : NOT_PUBLISHED,
    ...(resources && { resources: publishTimings ? resources : NOT_PUBLISHED }),
    host: run.host,
  };
  const records = fileURLToPath(new URL('../docs/scale-runs/', import.meta.url));
  await mkdir(records, { recursive: true });
  const recordFile = join(records, `${run.run}.json`);
  await writeFile(recordFile, await formatted(JSON.stringify(record), recordFile));

  const docs = fileURLToPath(new URL('../docs/scale-test.md', import.meta.url));
  const text = await readFile(docs, 'utf8');
  const start = '<!-- results:start -->';
  const end = '<!-- results:end -->';
  const [before, rest] = text.split(start);
  const [table, after] = (rest ?? '').split(end);
  if (!table || after === undefined) throw new Error('docs/scale-test.md has no results markers');
  // Recording a run again replaces its row; rows stay in run order (the run id is a UTC time).
  const [header = '', separator = '', ...rows] = table.trim().split('\n');
  const runId = (line) => /\d{8}T\d{6}Z/.exec(line)?.[0] ?? '';
  const kept = rows.filter((line) => runId(line) !== run.run);
  kept.push(`| ${row.join(' | ')} |`);
  kept.sort((a, b) => runId(a).localeCompare(runId(b)));
  const lines = [header, separator, ...kept];
  const updated = `${before}${start}\n\n${lines.join('\n')}\n\n${end}${after}`;
  await writeFile(docs, await formatted(updated, docs));
  console.log(`Recorded in docs/scale-test.md and docs/scale-runs/${run.run}.json`);
}
