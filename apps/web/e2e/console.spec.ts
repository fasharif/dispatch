import { expect, test } from '@playwright/test';
import { API_URL, signIn } from './support';

test.describe('dispatcher console', () => {
  test('refuses a wrong password with a clear message', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('dispatcher@dispatch.local');
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Email or password is incorrect' }),
    ).toBeVisible();
  });

  test('signs in, goes live and shows the map', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Live map of drivers and deliveries' }),
    ).toBeVisible();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  });

  test('adds a driver, then revokes the enrolled phone and deactivates the driver', async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.getByRole('tab', { name: 'Drivers' }).click();
    const name = `Browser Test ${String(Date.now())}`;
    await page.getByLabel('Driver name').fill(name);
    await page.getByLabel('Vehicle').fill('Van 7');
    await page.getByRole('button', { name: 'Add' }).click();
    const notice = page.getByRole('status').filter({ hasText: `Enrolment code for ${name}` });
    await expect(notice).toContainText(/[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}/);
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    // The driver types the code into the app; here the API call the app makes.
    const code = (await notice.locator('.code').textContent()) ?? '';
    const enrolled = await request.post(`${API_URL}/v1/devices/enrol`, {
      data: { code, deviceName: 'Test phone' },
    });
    expect(enrolled.status()).toBe(201);
    const device = {
      authorization: `Bearer ${((await enrolled.json()) as { deviceToken: string }).deviceToken}`,
    };
    expect((await request.get(`${API_URL}/v1/driver/me`, { headers: device })).status()).toBe(200);

    // The phone is lost: the dispatcher revokes it, and its token stops working at once.
    await page.getByRole('button', { name: `Phones and access for ${name}` }).click();
    const phones = page.getByRole('group', { name: `Phones of ${name}` });
    await expect(phones.getByText('Test phone')).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await phones.getByRole('button', { name: 'Revoke' }).click();
    await expect(phones.getByText(/^Revoked /)).toBeVisible();
    expect((await request.get(`${API_URL}/v1/driver/me`, { headers: device })).status()).toBe(401);

    // The driver leaves: deactivated, kept in the list for the deliveries that name them.
    page.once('dialog', (dialog) => void dialog.accept());
    await phones.getByRole('button', { name: 'Deactivate driver' }).click();
    const item = page.locator('li.driver-item').filter({ hasText: name });
    await expect(item).toContainText(/Deactivated \d+ \w+/);
    await expect(page.getByRole('button', { name: `Phones and access for ${name}` })).toHaveCount(
      0,
    );
  });

  test('creates a delivery by clicking pickup and drop-off on the map', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'New delivery' }).click();
    // Clicks count once the map has loaded its style and set up its layers.
    await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
    const map = page.locator('.maplibregl-canvas');
    const box = await map.boundingBox();
    if (!box) throw new Error('The map has no size');
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.6);
    await expect(page.getByText(/Pickup: \d+\.\d{5}, \d+\.\d{5}/)).toBeVisible();
    await expect(page.getByText(/Drop-off: \d+\.\d{5}, \d+\.\d{5}/)).toBeVisible();

    const reference = `BROWSER-${String(Date.now())}`;
    await page.getByLabel('Order reference').fill(reference);
    await page.getByLabel('Recipient').fill('Aisha Rahman');
    await page.getByLabel('Address').fill('Villa 12, Al Barsha 2, Dubai');
    await page.getByLabel('Assign the nearest free driver now').uncheck();
    await page.getByRole('button', { name: 'Create delivery' }).click();

    await expect(page.getByRole('heading', { name: reference })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(reference) })).toContainText(
      'Pending',
    );
  });
});
