import { expect, test } from '@playwright/test';
import { deliveryWithLink } from './support';

test.describe('customer tracking page', () => {
  test('follows the browser language: Arabic, right to left', async ({ browser, request }) => {
    const { token, orderReference } = await deliveryWithLink(request);
    const context = await browser.newContext({
      locale: 'ar-AE',
      extraHTTPHeaders: { 'accept-language': 'ar-AE,ar;q=0.9,en;q=0.5' },
    });
    const page = await context.newPage();
    await page.goto(`/track/${token}`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('تتبع التوصيل');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('قيد التجهيز');
    await expect(page.getByText(orderReference)).toBeVisible();

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delivery tracking');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Being prepared');
    await context.close();
  });

  test('defaults to English and explains an invalid link', async ({ page }) => {
    await page.goto('/track/v1.not-a-real.token');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('alert').filter({ hasText: 'This tracking link is not valid.' }),
    ).toBeVisible();
  });
});
