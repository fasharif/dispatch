// Captures the README screenshots from a running stack with live data (for example the
// simulator's demo: `npm run start -w @dispatch/simulator -- demo`).
//
//   WEB_URL=http://localhost:57300 API_URL=http://localhost:57100 node scripts/capture-screenshots.mjs
//
// Writes docs/screenshots/{console,proof,tracking-ar,tracking-en}.png.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:57300';
const API_URL = process.env.API_URL ?? 'http://localhost:57100';
const EMAIL = process.env.DISPATCH_EMAIL ?? 'dispatcher@dispatch.local';
const PASSWORD = process.env.DISPATCH_PASSWORD ?? 'dispatch-demo-2026';
const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

async function api(path, token, body) {
  const response = await fetch(`${API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

const { accessToken } = await api('/v1/auth/login', null, { email: EMAIL, password: PASSWORD });
const deliveries = await api('/v1/deliveries?limit=200', accessToken);
const onTheWay = deliveries.find((d) => d.status === 'picked_up');
const delivered = deliveries.find((d) => d.status === 'delivered' && d.proof);
if (!onTheWay || !delivered)
  throw new Error('Needs one delivery on the way and one delivered: run the demo first');
const link = await api(`/v1/deliveries/${onTheWay.id}/tracking-link`, accessToken, {});

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

const consolePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await consolePage.goto(WEB_URL);
await consolePage.getByLabel('Email').fill(EMAIL);
await consolePage.getByLabel('Password').fill(PASSWORD);
await consolePage.getByRole('button', { name: 'Sign in' }).click();
await consolePage.locator('[data-map-ready="true"]').waitFor();
await consolePage.getByRole('button', { name: new RegExp(onTheWay.orderReference) }).click();
await consolePage.waitForTimeout(4_000);
await consolePage.screenshot({ path: `${OUT}console.png` });

await consolePage.getByRole('button', { name: 'Delivered', exact: true }).click();
await consolePage.getByRole('button', { name: new RegExp(delivered.orderReference) }).click();
await consolePage.getByRole('heading', { name: 'Proof of delivery' }).scrollIntoViewIfNeeded();
await consolePage.waitForTimeout(3_000);
await consolePage.screenshot({ path: `${OUT}proof.png` });

for (const [lang, header] of [
  ['ar', 'ar-AE,ar;q=0.9'],
  ['en', 'en-GB,en;q=0.9'],
]) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    locale: lang === 'ar' ? 'ar-AE' : 'en-GB',
    extraHTTPHeaders: { 'accept-language': header },
  });
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/track/${link.token}`);
  await page.locator('[data-map-ready="true"]').waitFor();
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: `${OUT}tracking-${lang}.png`, fullPage: true });
  await context.close();
}

await browser.close();
console.log(`Screenshots written to ${OUT}`);
