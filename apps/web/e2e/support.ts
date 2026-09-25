import type { APIRequestContext, Page } from '@playwright/test';

export const API_URL = process.env.API_URL ?? 'http://localhost:57100';
export const EMAIL = process.env.DISPATCH_EMAIL ?? 'dispatcher@dispatch.local';
export const PASSWORD = process.env.DISPATCH_PASSWORD ?? 'dispatch-demo-2026';

export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function apiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_URL}/v1/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

/** A fresh delivery and a tracking link for it, created through the API. */
export async function deliveryWithLink(
  request: APIRequestContext,
): Promise<{ id: string; orderReference: string; url: string; token: string }> {
  const token = await apiToken(request);
  const headers = { authorization: `Bearer ${token}` };
  const orderReference = `E2E-${String(Date.now())}`;
  const created = await request.post(`${API_URL}/v1/deliveries`, {
    headers,
    data: {
      orderReference,
      recipientName: 'Aisha Rahman',
      address: 'Villa 12, Al Barsha 2, Dubai',
      pickup: { lat: 25.1415, lng: 55.2263 },
      dropoff: { lat: 25.0971, lng: 55.2019 },
    },
  });
  const delivery = (await created.json()) as { id: string };
  const link = await request.post(`${API_URL}/v1/deliveries/${delivery.id}/tracking-link`, {
    headers,
    data: {},
  });
  const { url, token: trackingToken } = (await link.json()) as { url: string; token: string };
  return { id: delivery.id, orderReference, url, token: trackingToken };
}
