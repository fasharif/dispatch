// Captures frames of the dispatcher console while the simulator's demo runs, for the README's
// animated picture (scripts/record-demo-gif.sh assembles them).
//
//   WEB_URL=http://localhost:57080 API_URL=http://localhost:57080 \
//     node scripts/capture-demo-frames.mjs <frames dir> [frames=40] [interval ms=1000]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:57300';
const API_URL = process.env.API_URL ?? 'http://localhost:57100';
const EMAIL = process.env.DISPATCH_EMAIL ?? 'dispatcher@dispatch.local';
const PASSWORD = process.env.DISPATCH_PASSWORD ?? 'dispatch-demo-2026';
const [dir, frames = '40', interval = '1000'] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: node scripts/capture-demo-frames.mjs <frames dir> [frames] [interval ms]');
  process.exit(2);
}

const login = await fetch(`${API_URL}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const { accessToken } = await login.json();
const deliveries = await (
  await fetch(`${API_URL}/v1/deliveries?limit=200`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
).json();
const onTheWay = deliveries.find((d) => d.status === 'picked_up');
if (!onTheWay) throw new Error('Needs a delivery on its way: run the demo first');

await mkdir(dir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(WEB_URL);
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.locator('[data-map-ready="true"]').waitFor();
await page.getByRole('button', { name: new RegExp(onTheWay.orderReference) }).click();
await page.waitForTimeout(3_000);
for (let i = 0; i < Number(frames); i += 1) {
  await page.screenshot({ path: join(dir, `${String(i).padStart(3, '0')}.png`) });
  await page.waitForTimeout(Number(interval));
}
await browser.close();
console.log(`${frames} frames written to ${dir}`);
