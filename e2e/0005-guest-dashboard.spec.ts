import { expect, test, type Page } from '@playwright/test';
import { installApp, loginUser } from './fixtures/fixtures';
import { clearDatabase, db } from './helpers/db';

const guestSetting = (page: Page) => page.getByRole('switch', { name: /Enable guest dashboard/ });
const manage = (page: Page) => page.getByRole('link', { name: 'Manage shared applications' });
const logOut = (page: Page) => page.getByRole('button', { name: 'Log out' }).click();

async function setGuestDashboard(page: Page, enabled: boolean) {
  const setting = guestSetting(page);
  await expect(setting).toBeVisible();
  if ((await setting.getAttribute('aria-checked')) !== String(enabled)) {
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/user-settings') && response.request().method() === 'PATCH');
    await setting.click();
    expect((await saved).ok()).toBe(true);
    await expect(setting).not.toHaveAttribute('aria-busy', 'true');
  }
  if (enabled) {
    await expect(manage(page)).toHaveAttribute('href', '/apps');
  } else {
    await expect(manage(page)).toHaveCount(0);
  }
}

async function enableGuestDashboard(page: Page) {
  await page.goto('/settings?tab=general');
  await setGuestDashboard(page, false);
  await setGuestDashboard(page, true);
}

test.beforeEach(async () => {
  await clearDatabase();
});

test('an operator can enable the guest dashboard and see its empty public view', async ({ page, context }) => {
  await loginUser(page, context);
  await enableGuestDashboard(page);
  await logOut(page);

  await expect(page.getByText('No shared apps')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
  await expect(manage(page)).toHaveCount(0);
});

test('the public guest dashboard shows only shared apps and offers their launch addresses', async ({ page, context }) => {
  test.slow();
  await loginUser(page, context);
  await enableGuestDashboard(page);

  const store = await db.query.appStore.findFirst();
  if (!store) throw new Error('No store found');
  const domain = 'shared-app.example.test';
  await context.route(`https://${domain}/**`, (route) => route.fulfill({ body: 'Shared app launch' }));

  await installApp(page, store.slug, 'nginx', { visibleOnGuestDashboard: true, domain });
  await installApp(page, store.slug, 'whoami', { visibleOnGuestDashboard: false });
  await logOut(page);

  const sharedApp = page.getByRole('button', { name: 'Open Nginx' });
  await expect(sharedApp).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Whoami' })).toHaveCount(0);
  await expect(manage(page)).toHaveCount(0);
  await sharedApp.press('Enter');

  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('menuitem', { name: domain }).click()]);
  await expect(popup).toHaveURL(`https://${domain}/`);
  await popup.close();
});

test('disabling the guest dashboard removes Manage and sends logged-out users to Login', async ({ page, context }) => {
  await loginUser(page, context);
  await enableGuestDashboard(page);

  await setGuestDashboard(page, false);
  await logOut(page);

  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
});
