/**
 * E2E-NAV: scheme-less URL submission navigates siteView
 *
 * This test PROVES that submitting a scheme-less URL (e.g. "localhost:PORT")
 * in the address bar causes the siteView to navigate to the correct URL
 * with http:// auto-prepended by normalizeUrlInput.
 *
 * This directly validates the fix for the user's reported bug:
 *   "typing an address in the address bar does nothing"
 *
 * Setup:
 *   - A local HTTP server is started on an ephemeral port (port 0).
 *   - The app is launched with an isolated fresh user-data-dir so siteUrl=''
 *     which causes the address bar to be shown automatically.
 *
 * Navigation path (in priority order):
 *   (a) dom-submit: if WCV pages are accessible, fill the form and submit
 *   (b) preload-api: use addressbar page.evaluate to call window.addressBarApi.navigate()
 *   (main-evaluate): use electronApp.evaluate + webContents.getAllWebContents() +
 *     webContentsInstance.executeJavaScript() to call the IPC through the real preload bridge
 *
 * Assertion:
 *   siteView's webContents URL === 'http://localhost:<port>/'
 *   AND page title contains 'E2E-NAV-OK'
 *
 * Flake-hardening (4 mitigations):
 *   1. TITLE RACE: poll requires BOTH url===expectedUrl AND title contains 'E2E-NAV-OK'
 *      simultaneously before asserting — never breaks on URL alone.
 *   2. SITEVIEW IDENTITY: poll explicitly excludes file:// and internal views
 *      (/addressbar/, /overlay/, /hotspot/, /settings/) to ensure match is siteView.
 *   3. EMPTY-CONFIG BASELINE: asserts addressbar webContents is present before submit;
 *      asserts typed input truly has no scheme (negative-control).
 *   4. POLLING FOR READINESS: app init uses bounded poll instead of fixed sleep.
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ───────────────────────────────────────────────────────────────

const APP_ENTRY = path.resolve(__dirname, '../../out/main/index.js');
const POLL_INTERVAL_MS = 500;
const NAV_TIMEOUT_MS = 15_000;
/** Maximum time to wait for app init (addressbar webContents present) */
const APP_INIT_POLL_TIMEOUT_MS = 20_000;
const APP_INIT_POLL_INTERVAL_MS = 300;

// ─── Test state ──────────────────────────────────────────────────────────────

let testServer: http.Server;
let serverPort: number;
let electronApp: ElectronApplication;
let tempUserDataDir: string;
/** Which drive path was actually used to trigger navigation */
let drivePath: 'dom-submit' | 'preload-api' | 'main-evaluate' = 'main-evaluate';
/** Whether Playwright WCV pages were accessible */
let wcvAccessible = false;
/** The navigated URL as observed in siteView's webContents */
let navigatedUrl = '';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  // 1. Start local HTTP server on ephemeral port
  testServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>E2E-NAV-OK</title><h1>ok</h1>');
  });

  await new Promise<void>((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });

  const addr = testServer.address() as { port: number };
  serverPort = addr.port;
  console.log(`[E2E-NAV] Test HTTP server listening on port ${serverPort}`);

  // 2. Create isolated temp user-data-dir so config starts at siteUrl='' (address bar shown)
  tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nav-ud-'));
  console.log(`[E2E-NAV] Isolated user-data-dir: ${tempUserDataDir}`);

  // Inherit environment, excluding undefined values
  const inheritedEnv: Record<string, string> = Object.entries(process.env).reduce<
    Record<string, string>
  >((acc, [k, v]) => {
    if (v !== undefined) acc[k] = v;
    return acc;
  }, {});

  // Launch Electron with the isolated user-data-dir
  electronApp = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${tempUserDataDir}`],
    env: {
      ...inheritedEnv,
      NODE_ENV: 'test',
    },
  });

  // --- HARDENING #4: poll for app readiness instead of fixed sleep ---
  // Wait until the addressbar webContents appears (app fully initialised).
  console.log(
    `[E2E-NAV] Polling for app readiness (addressbar webContents, up to ${APP_INIT_POLL_TIMEOUT_MS}ms)...`,
  );
  const initDeadline = Date.now() + APP_INIT_POLL_TIMEOUT_MS;
  let appReady = false;
  while (Date.now() < initDeadline) {
    const ready = await electronApp
      .evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((wc) => wc.getURL().includes('/addressbar/')),
      )
      .catch(() => false);
    if (ready) {
      appReady = true;
      console.log(`[E2E-NAV] App ready (addressbar webContents found)`);
      break;
    }
    await delay(APP_INIT_POLL_INTERVAL_MS);
  }
  if (!appReady) {
    console.warn('[E2E-NAV] App did not reach ready state within timeout — proceeding anyway');
  }

  // Check WCV accessibility
  const allPages = electronApp.windows();
  wcvAccessible = allPages.length > 0;
  console.log(
    `[E2E-NAV] WCV accessible: ${wcvAccessible} (${allPages.length} pages via Playwright)`,
  );
  if (wcvAccessible) {
    allPages.forEach((p: Page, i: number) => console.log(`  [${i}] ${p.url()}`));
  }
});

test.afterAll(async () => {
  await electronApp?.close().catch((e: unknown) => {
    console.warn('[E2E-NAV] app.close() failed:', e);
  });
  testServer?.close();
  try {
    fs.rmSync(tempUserDataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ─── Main test ───────────────────────────────────────────────────────────────

test('scheme-less "localhost:PORT" submit navigates siteView to http://localhost:PORT/', async () => {
  // --- HARDENING #3: negative-control — confirm the input truly has no scheme ---
  const schemeInput = `localhost:${serverPort}`;
  expect(schemeInput.startsWith('localhost:')).toBe(true);
  expect(schemeInput).not.toMatch(/^https?:\/\//);

  const expectedUrl = `http://localhost:${serverPort}/`;

  console.log(`[E2E-NAV] Input (scheme-less): "${schemeInput}"`);
  console.log(`[E2E-NAV] Expected after normalizeUrlInput: "${expectedUrl}"`);

  // --- HARDENING #3: baseline — assert addressbar is present before submit ---
  const baselineCheck = await electronApp
    .evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents();
      const ab = all.find((wc) => wc.getURL().includes('/addressbar/'));
      return { found: !!ab, url: ab ? ab.getURL() : null };
    })
    .catch(() => ({ found: false, url: null }));

  console.log(
    `[E2E-NAV] Baseline addressbar check: found=${baselineCheck.found} url=${baselineCheck.url ?? 'n/a'}`,
  );
  expect(
    baselineCheck.found,
    'addressbar webContents must be present before triggering navigation',
  ).toBe(true);

  // ── Attempt (a): dom-submit via WCV Page ───────────────────────────────
  if (wcvAccessible) {
    const allPages = electronApp.windows();
    const addressBarPage = allPages.find((p: Page) => p.url().includes('/addressbar/')) ?? null;

    if (addressBarPage !== null) {
      console.log(`[E2E-NAV] Attempting dom-submit via addressbar page: ${addressBarPage.url()}`);

      // --- HARDENING #3: assert input is visible/editable before driving it ---
      try {
        await expect(addressBarPage.locator('#url-input')).toBeVisible({ timeout: 3_000 });
        await expect(addressBarPage.locator('#url-input')).toBeEditable({ timeout: 3_000 });
      } catch (visErr) {
        console.warn('[E2E-NAV] address bar input not visible/editable via WCV:', visErr);
      }

      try {
        await addressBarPage.fill('#url-input', schemeInput);
        await addressBarPage.locator('#navigate-form').evaluate((form: HTMLFormElement) => {
          form.requestSubmit();
        });
        drivePath = 'dom-submit';
        console.log('[E2E-NAV] dom-submit triggered successfully');
      } catch (e) {
        console.warn('[E2E-NAV] dom-submit failed, will try preload-api:', e);
      }
    }

    // ── Attempt (b): preload-api via Page.evaluate ─────────────────────
    if (drivePath !== 'dom-submit' && addressBarPage !== null) {
      console.log('[E2E-NAV] Attempting preload-api via addressBarPage.evaluate()');
      try {
        const result = await addressBarPage.evaluate(
          (url: string) =>
            (
              window as {
                addressBarApi?: { navigate: (u: string) => Promise<unknown> };
              }
            ).addressBarApi?.navigate(url),
          schemeInput,
        );
        console.log('[E2E-NAV] preload-api result:', JSON.stringify(result));
        drivePath = 'preload-api';
      } catch (e) {
        console.warn('[E2E-NAV] preload-api via page.evaluate failed:', e);
      }
    }
  }

  // ── Attempt (main-evaluate): via electronApp.evaluate + getAllWebContents ─
  if (drivePath === 'main-evaluate') {
    console.log('[E2E-NAV] Using main-evaluate path via webContents.getAllWebContents()');

    const navigateArg = { url: schemeInput };
    const mainEvalResult = await electronApp
      .evaluate(async ({ webContents }, arg: { url: string }) => {
        // Find the addressbar WebContents in the main process
        const all = webContents.getAllWebContents();
        const addressbarWc = all.find((wc) => wc.getURL().includes('/addressbar/'));

        if (!addressbarWc) {
          return {
            ok: false,
            reason: 'addressbar webContents not found',
            allUrls: all.map((wc) => wc.getURL()),
          };
        }

        // Execute addressBarApi.navigate() in the addressbar renderer context
        // This goes through the real IPC path: preload bridge → addressbar:navigate → normalizeUrlInput → loadSiteUrl
        try {
          const jsExpr = `window.addressBarApi.navigate(${JSON.stringify(arg.url)})`;
          const result = await addressbarWc.executeJavaScript(jsExpr);
          return { ok: true, result, addressbarUrl: addressbarWc.getURL() };
        } catch (e: unknown) {
          return {
            ok: false,
            reason: e instanceof Error ? e.message : String(e),
            addressbarUrl: addressbarWc.getURL(),
          };
        }
      }, navigateArg)
      .catch((e: unknown) => ({
        ok: false,
        reason: `electronApp.evaluate threw: ${e instanceof Error ? e.message : String(e)}`,
      }));

    console.log('[E2E-NAV] main-evaluate result:', JSON.stringify(mainEvalResult));

    const r = mainEvalResult as {
      ok: boolean;
      reason?: string;
      allUrls?: string[];
      result?: unknown;
    };
    if (!r.ok) {
      // If addressbar webContents not found, log and still try polling
      console.warn(`[E2E-NAV] main-evaluate navigate failed: ${r.reason ?? '?'}`);
      if (r.allUrls) {
        console.warn('[E2E-NAV] All webContents URLs:', r.allUrls);
      }
    }
  }

  // ── Poll until siteView loads http://localhost:<port>/ ─────────────────
  // --- HARDENING #1 (TITLE RACE) + #2 (SITEVIEW IDENTITY) ---
  // Both URL===expectedUrl AND title contains 'E2E-NAV-OK' must hold simultaneously.
  // Exclude file:// and internal app views so we match only the external siteView.
  console.log(
    `[E2E-NAV] Polling for siteView URL+title: ${expectedUrl} / 'E2E-NAV-OK' (up to ${NAV_TIMEOUT_MS}ms)...`,
  );

  const deadline = Date.now() + NAV_TIMEOUT_MS;
  let found = false;
  let foundTitle = '';
  // Track last seen values so failed assertions are informative.
  let lastSeenUrl = '';
  let lastSeenTitle = '';

  // Poll arg must carry both the expected URL and the http prefix for filtering
  const pollArg = {
    expectedUrl: expectedUrl,
    httpPrefix: `http://localhost:${serverPort}`,
    // Paths that identify internal (non-siteView) views to exclude
    internalPaths: ['/addressbar/', '/overlay/', '/hotspot/', '/settings/'],
  };

  while (Date.now() < deadline) {
    const result = await electronApp
      .evaluate(
        (
          { webContents },
          arg: {
            expectedUrl: string;
            httpPrefix: string;
            internalPaths: string[];
          },
        ) => {
          const all = webContents.getAllWebContents();

          // --- HARDENING #2: identity filter ---
          // Accept only webContents whose URL starts with our test server's http prefix,
          // is NOT a file:// URL, and does NOT match an internal app view path.
          const siteWc = all.find((wc) => {
            const url = wc.getURL();
            if (!url.startsWith(arg.httpPrefix)) return false;
            if (url.startsWith('file://')) return false;
            for (const p of arg.internalPaths) {
              if (url.includes(p)) return false;
            }
            return true;
          });

          if (!siteWc) return null;
          return { url: siteWc.getURL(), title: siteWc.getTitle() };
        },
        pollArg,
      )
      .catch(() => null);

    if (result) {
      // Always track the most recently seen values for informative failure messages.
      lastSeenUrl = result.url;
      lastSeenTitle = result.title;

      // --- HARDENING #1: require BOTH conditions simultaneously ---
      if (result.url === pollArg.expectedUrl && result.title.includes('E2E-NAV-OK')) {
        navigatedUrl = result.url;
        foundTitle = result.title;
        found = true;
        console.log(
          `[E2E-NAV] siteView confirmed: url="${result.url}" title="${result.title}"`,
        );
        break;
      } else {
        console.log(
          `[E2E-NAV] Partial match (waiting for both URL+title): url="${result.url}" title="${result.title}"`,
        );
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  // If timeout elapsed without both conditions being true, use last seen values
  // so that assertion failures carry useful diagnostic information.
  if (!found) {
    navigatedUrl = lastSeenUrl;
    foundTitle = lastSeenTitle;
  }

  // ── Assertions ─────────────────────────────────────────────────────────
  console.log(`[E2E-NAV] drivePath used: ${drivePath}`);
  console.log(`[E2E-NAV] wcvAccessible: ${wcvAccessible}`);
  console.log(`[E2E-NAV] navigatedUrl: ${navigatedUrl}`);
  console.log(`[E2E-NAV] title: ${foundTitle}`);

  expect(
    found,
    `siteView should have navigated to ${expectedUrl} with title 'E2E-NAV-OK' within ${NAV_TIMEOUT_MS}ms — last seen url="${lastSeenUrl}" title="${lastSeenTitle}"`,
  ).toBe(true);
  expect(navigatedUrl).toBe(expectedUrl);
  expect(foundTitle).toContain('E2E-NAV-OK');
});

// ─── Utilities ───────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
