// Summarises one scale-test run (load/results/<run>/) as Markdown.
//
//   node load/report.mjs load/results/<run>                    print and write summary.md
//   node load/report.mjs load/results/<run> --docs             also record the run in docs/
//   node load/report.mjs load/results/<run> --docs --publish-timings
//
// Counts (fixes stored, received, lost) are always reported. Latency is reported only with
// --publish-timings: runs on a busy development machine are functional checks, and their timings
// would mislead. The quiet-machine run passes the flag.
//
// --docs adds (or replaces) the run's row in docs/scale-test.md and writes the counts behind it to
// docs/scale-runs/<run>.json, so every published row can be checked. The raw results folder is not
// committed: its fleet file holds device tokens.
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

const ms = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} ms`);
const timing = (value) => (publishTimings ? ms(value) : 'pending (quiet-machine run)');
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
// Runs before the compose names followed the project recorded "dispatch-api-2".
const killed = run.killedInstance.replace(/^dispatch-/, '');
const survivor = run.survivingInstance.replace(/^dispatch-/, '');
const replayed = k6.fixesDuplicate + k6.batchRetries;

const environment = `${run.host.os}, Docker ${run.host.dockerServerVersion}, ${run.host.dockerCpus} CPUs, ${gib(run.host.dockerMemoryBytes)}; commit ${run.gitCommit}`;

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
  timing(reconnecting.listen.latencyAllMs.p95),
  timing(surviving.listen.latencyLiveMs.p95),
  environment,
];

const consoleLine = (name, { listen, verify }, where) =>
  `| Console ${name} (${where}) | received ${verify.receivedFixes}, lost **${verify.lost}**; connections ${listen.connects} (${listen.instances.join(' → ') || 'none reported'}), resumes ${listen.resumes}, recovered by resume ${listen.resumedEvents} |`;

const summary = `# Scale test ${run.run}

| | |
| --- | --- |
| Drivers (k6 virtual users) | ${run.drivers}, one fix every ${run.intervalSeconds} s for ${run.durationSeconds} s |
| API instances | 2 behind nginx, Socket.IO Redis adapter; ${killed} killed with SIGKILL at ${run.killedAt} |
| Fixes recorded by k6 | ${k6.fixesRecorded} (accepted ${k6.fixesAccepted}, duplicate ${k6.fixesDuplicate}, refused ${k6.fixesRefused}, unacknowledged ${k6.fixesUnacknowledged}) |
| Batch retries (k6) | ${k6.batchRetries}; batches that failed six attempts ${k6.batchesFailed}; replayed batches in total: ${replayed} |
| Fixes stored (database) | ${reconnecting.verify.storedFixes} |
${consoleLine('A', reconnecting, `through nginx, on the killed instance ${killed}`)}
${consoleLine('B', surviving, `connected to ${survivor} directly`)}
| **Lost events** | **${reconnecting.verify.lost + surviving.verify.lost}** |
| p95 driver-to-console latency, all fixes (console A) | ${timing(reconnecting.listen.latencyAllMs.p95)} |
| p95 driver-to-console latency, live fixes (console B) | ${timing(surviving.listen.latencyLiveMs.p95)} |
| Environment | ${run.host.os}, Docker ${run.host.dockerServerVersion} with ${run.host.dockerCpus} CPUs and ${gib(run.host.dockerMemoryBytes)} shared by all containers; commit ${run.gitCommit} |
`;

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
  // Counts only, unless timings are published: no device tokens, ids or latencies.
  const record = {
    run: run.run,
    gitCommit: run.gitCommit,
    drivers: run.drivers,
    durationSeconds: run.durationSeconds,
    intervalSeconds: run.intervalSeconds,
    killedInstance: killed,
    survivingInstance: survivor,
    killedAt: run.killedAt,
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
    latencyP95Ms: publishTimings
      ? {
          consoleAAllFixes: reconnecting.listen.latencyAllMs.p95,
          consoleBLiveFixes: surviving.listen.latencyLiveMs.p95,
        }
      : 'not published (shared machine)',
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
