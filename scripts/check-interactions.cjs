// Deterministic browser integration: no external map/elevation traffic or real GPS.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const math = require('../route-math');
const segments = [[[48, 2], [48.01, 2], [48.01, 2.01]]];
const geometry = math.buildGeometry(segments);
const fixture = {
  ref: 'GR1', segments, segmentPointMeters: geometry.segments.map(s => s.pointOffsets),
  totalKm: geometry.totalMeters / 1000, chainCount: 1, maxJoinGap: 0, rawSegmentCount: 1,
  cities: [{ name: 'Départ test', place: 'village', km: 0 }, { name: 'Arrivée test', place: 'village', km: geometry.totalMeters / 1000 }]
};

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  let elevations = 0, nearbyFetches = 0;
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  await page.addInitScript(() => {
    window.mockFix = { coords: { latitude: 48, longitude: 2, accuracy: 5 }, timestamp: Date.now() };
    window.gpsCalls = 0; window.gpsStops = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(ok, fail) { window.gpsCalls++; if (window.gpsDenied) fail({ code: 1 }); else ok({ ...window.mockFix, timestamp: Date.now() }); },
      watchPosition(ok, fail) {
        window.gpsCalls++; window.gpsSuccess = ok; window.gpsFailure = fail;
        if (window.gpsDenied) setTimeout(() => fail({ code: 1 }), 0);
        else setTimeout(() => ok({ ...window.mockFix, timestamp: Date.now() }), 0);
        return 7;
      },
      clearWatch() { window.gpsStops++; }
    } });
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.open-meteo.com') {
      elevations++;
      return route.fulfill({ json: { elevation: url.searchParams.get('latitude').split(',').map(() => 100) } });
    }
    if (url.hostname !== 'interaction.test') return route.abort();
    if (url.pathname.endsWith('/route-cache/GR1.json')) return route.fulfill({ json: fixture });
    if (url.pathname.endsWith('/nearby-routes.json')) nearbyFetches++;
    try {
      const file = path.join(root, decodeURIComponent(url.pathname));
      const body = await fs.readFile(file);
      return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  async function gps(latitude, longitude, accuracy = 5, age = 0) {
    await page.evaluate(({ latitude, longitude, accuracy, age }) => window.gpsSuccess({ coords: { latitude, longitude, accuracy }, timestamp: Date.now() - age }), { latitude, longitude, accuracy, age });
  }
  try {
    await page.goto('http://interaction.test/mobile-web/index.html');
    assert.equal(await page.evaluate(() => window.gpsCalls), 0);
    assert.equal(nearbyFetches, 0);
    await page.evaluate(() => { window.gpsDenied = true; });
    await page.click('#locate-nearby');
    await expect(page.locator('#nearby-status')).toContainText('refusée');
    await page.evaluate(() => { window.gpsDenied = false; });
    await page.click('#locate-nearby');
    await expect(page.locator('.nearby-card')).toHaveCount(3);
    assert.equal(nearbyFetches, 1);
    await page.click('#clear-location');
    await expect(page.locator('.nearby-card')).toHaveCount(0);
    console.log('Nearby: opt-in, denial, retry, three ranked routes, clear OK');

    await page.goto('http://interaction.test/mobile-web/gr.html?ref=GR1');
    await expect(page.locator('#status')).toContainText('km');
    assert.equal(elevations, 0, 'Elevation is lazy');
    await page.click('#route-planner-toggle');
    await expect(page.locator('[data-panel="start"]')).toBeVisible();
    await expect(page.locator('[data-panel="end"]')).toBeHidden();
    await page.fill('#city-start', 'départ');
    await page.click('#city-start-list .city-choice');
    await expect(page.locator('[data-panel="end"]')).toBeVisible();
    await page.fill('#city-end', 'arrivée');
    await page.click('#city-end-list .city-choice');
    await expect(page.locator('[data-panel="summary"]')).toBeVisible();
    await expect(page.locator('#route-planner-summary')).toContainText('1,9 km');
    await page.fill('#trip-days', '2');
    await expect(page.locator('.route-stage-chip')).toHaveCount(2);
    await page.click('#hike-start');
    await expect(page.locator('#hike-remaining')).toContainText('1,9 km');
    await gps(48.005, 2);
    await expect(page.locator('#hike-remaining')).toContainText('1,3 km');
    for (const [width, height] of [[320, 568], [844, 390], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        mapHeight: document.getElementById('map').getBoundingClientRect().height,
        bottom: document.getElementById('status').getBoundingClientRect().bottom
      }));
      assert.equal(layout.overflow, false, 'Tracking: no horizontal overflow');
      assert(layout.mapHeight > 60, `Tracking map still usable at ${width}x${height}`);
      assert(layout.bottom <= height + 1, 'Tracking controls remain in viewport');
    }
    await gps(48.1, 2.1);
    await expect(page.locator('#hike-message')).toContainText('Rejoignez le tracé');
    await expect(page.locator('#hike-remaining')).toHaveText('—');
    await gps(48.005, 2, 500);
    await expect(page.locator('#hike-message')).toContainText('imprécise');
    await gps(48.005, 2, 5, 40000);
    await expect(page.locator('#hike-message')).toContainText('ancien');
    await gps(48.01, 2.01);
    await expect(page.locator('#hike-remaining')).toHaveText('Arrivée !');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app-visibility', { detail: { isActive: false } })));
    assert.equal(await page.evaluate(() => window.gpsStops), 1);
    await expect(page.locator('#hike-message')).toContainText('pause');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app-visibility', { detail: { isActive: true } })));
    await expect(page.locator('#hike-remaining')).toContainText('1,9 km');
    await page.click('#hike-stop');
    await expect(page.locator('#hike-progress')).toBeHidden();
    assert.equal(await page.evaluate(() => window.gpsStops), 2);
    console.log('Planner + GPS: automatic steps, days, along-trail progress, off-route, precision, stale, arrival, pause/resume/stop OK');

    await page.click('#route-planner-toggle');
    await page.click('[data-step="start"]');
    await page.click('[data-action="pick-map"][data-role="start"]');
    await expect(page.locator('#map-pick-prompt')).toBeVisible();
    await expect(page.locator('#route-planner-card')).toBeHidden();
    await page.click('#cancel-map-pick');
    await expect(page.locator('#route-planner-card')).toBeVisible();
    await page.click('#planner-location');
    await expect(page.locator('#step-start-label')).toHaveText('Ma position');
    await expect(page.locator('[data-panel="end"]')).toBeVisible();
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('app-back', { cancelable: true }))), false);
    await expect(page.locator('#route-planner-card')).toBeHidden();
    await page.evaluate(() => { window.gpsDenied = true; });
    await page.click('#hike-locate');
    await expect(page.locator('#hike-message')).toContainText('refusée');
    await expect(page.locator('#hike-locate')).toBeVisible();
    console.log('Map pick/cancel, GPS start, back from planner and GPS denial recovery OK');
    await page.evaluate(() => { window.gpsDenied = false; });
    await page.click('#hike-locate');
    await expect(page.locator('#hike-remaining')).toContainText('km');
    await page.clock.install();
    await page.evaluate(() => window.gpsFailure({ code: 3 }));
    await expect(page.locator('#hike-message')).toContainText('Nouvelle recherche');
    await expect(page.locator('#hike-stop')).toBeVisible();
    await page.clock.runFor(5010);
    await expect(page.locator('#hike-remaining')).toContainText('km');
    await page.click('#hike-stop');
    console.log('Temporary GPS loss automatically retries and recovers OK');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
