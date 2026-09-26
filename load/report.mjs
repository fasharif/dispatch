// Summarises one scale-test run (load/results/<run>/) as Markdown.
//
//   node load/report.mjs load/results/<run>                    print and write summary.md
//   node load/report.mjs load/results/<run> --docs             also record the run in docs/scale-test.md
//   node load/report.mjs load/results/<run> --docs --publish-timings
//
// Counts (fixes stored, received, lost) are always reported. Latency is reported only with
// --publish-timings: runs on a busy development machine are functional checks, and their timings
// would mislead. The quiet-machine run passes the flag.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
const killed = run.killedInstance.replace(/^dispatch-/, '');
const survivor = run.survivingInstance.replace(/^dispatch-/, '');
const replayed = k6.fixesDuplicate + k6.batchRetries;

const environment = `${run.host.os}, Docker ${run.host.dockerServerVersion}, ${run.host.dockerCpus} CPUs, ${gib(run.host.dockerMemoryBytes)}; commit ${run.gitCommit}`;

const row = [
  run.run,
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
| API instances | 2 behind nginx, Socket.IO Redis adapter; ${run.killedInstance} killed with SIGKILL at ${run.killedAt} |
| Fixes recorded by k6 | ${k6.fixesRecorded} (accepted ${k6.fixesAccepted}, duplicate ${k6.fixesDuplicate}, refused ${k6.fixesRefused}, unacknowledged ${k6.fixesUnacknowledged}) |
| Batch retries (k6) | ${k6.batchRetries}; replayed batches in total: ${replayed} |
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
  const docs = new URL('../docs/scale-test.md', import.meta.url);
  const text = await readFile(docs, 'utf8');
  const start = '<!-- results:start -->';
  const end = '<!-- results:end -->';
  const [before, rest] = text.split(start);
  const [table, after] = (rest ?? '').split(end);
  if (!table || after === undefined) throw new Error('docs/scale-test.md has no results markers');
  const lines = table.trim().split('\n');
  lines.push(`| ${row.join(' | ')} |`);
  await writeFile(docs, `${before}${start}\n\n${lines.join('\n')}\n\n${end}${after}`);
  console.log('Recorded in docs/scale-test.md');
}
