import { expect, test, type WebSocketRoute } from '@playwright/test';
import { API_URL, apiToken, signIn } from './support';

/**
 * The console's WebSocket is routed through Playwright, so the test can drop the connection and
 * refuse new ones for a while, as a failing API instance or a lost network would.
 */
test('shows deliveries changed while the console was disconnected once it reconnects', async ({
  page,
  request,
}) => {
  let refuse = false;
  const connections: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    if (refuse) {
      void ws.close({ code: 1011, reason: 'test: refused' });
      return;
    }
    connections.push({ page: ws, server: ws.connectToServer() });
  });

  const headers = { authorization: `Bearer ${await apiToken(request)}` };
  const stamp = String(Date.now());
  const newDelivery = (orderReference: string) =>
    request.post(`${API_URL}/v1/deliveries`, {
      headers,
      data: {
        orderReference,
        recipientName: 'Mariam Saleh',
        address: 'Villa 3, Umm Suqeim 2, Dubai',
        pickup: { lat: 25.1415, lng: 55.2263 },
        dropoff: { lat: 25.1501, lng: 55.2057 },
      },
    });
  const toCancel = `RECONNECT-A-${stamp}`;
  const created = (await (await newDelivery(toCancel)).json()) as { id: string };

  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(toCancel) })).toContainText('Pending');

  // The connection drops, and reconnecting fails for now.
  refuse = true;
  for (const connection of connections.splice(0)) {
    await connection.server.close();
    await connection.page.close();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting' })).toBeVisible();

  // Meanwhile one delivery is cancelled and another is created. No event reaches the console.
  const cancelled = await request.post(`${API_URL}/v1/deliveries/${created.id}/cancel`, {
    headers,
    data: { reason: 'The customer cancelled the order' },
  });
  expect(cancelled.status()).toBe(200);
  const createdMeanwhile = `RECONNECT-B-${stamp}`;
  expect((await newDelivery(createdMeanwhile)).status()).toBe(201);

  refuse = false;
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(toCancel) })).toContainText('Cancelled');
  await expect(page.getByRole('button', { name: new RegExp(createdMeanwhile) })).toContainText(
    'Pending',
  );
});
