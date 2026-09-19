// Run with Playwright available in NODE_PATH. Network requests are mocked:
// layout checks must not generate traffic to community map tile servers.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'layout.test') return route.abort();
    const file = path.join(root, decodeURIComponent(url.pathname));
    try {
      const body = await fs.readFile(file);
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };
      await route.fulfill({ body, contentType: types[path.extname(file)] || 'application/octet-stream' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function check(selectors, label) {
    const result = await page.evaluate(selectors => {
      const boxes = selectors.map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.width && a.height && b.width && b.height && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) overlaps.push([a.selector, b.selector]);
      }
      return { overlaps, overflow: document.documentElement.scrollWidth > innerWidth, boxes };
    }, selectors);
    assert.equal(result.overflow, false, `${label}: horizontal overflow`);
    assert.deepEqual(result.overlaps, [], `${label}: ${JSON.stringify(result.overlaps)}`);
    if (selectors.includes('#map')) for (const b of result.boxes) {
      assert(b.y >= -1 && b.bottom <= (await page.viewportSize()).height + 1, `${label}: ${b.selector} outside viewport`);
    }
  }
  try {
    for (const [width, height] of [[320, 568], [390, 844], [720, 480], [844, 390], [1024, 768], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.goto('http://layout.test/mobile-web/index.html');
      await check(['.region-panel', '.list-panel', '.site-header'], `home ${width}`);
      await page.goto('http://layout.test/mobile-web/gr.html?ref=GR1');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('km'));
      const selectors = ['.site-header-route', '#map', '#status', '#route-planner'];
      await check(selectors, `map ${width}`);
      await page.click('#route-planner-toggle');
      await check(selectors, `planner ${width}`);
      if (width === 390) await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'vadrouille-layout-mobile.png') });
      await page.evaluate(() => { document.querySelector('#title').textContent = 'GR 60 — Un très long nom de randonnée entre plusieurs villes et massifs de France'; });
      await check(selectors, `long title ${width}`);
      await page.click('#route-planner-close');
      await check(selectors, `closed ${width}`);
      console.log(`Layout OK: ${width}x${height} (home, map, planner, long title, close)`);
    }
    assert.deepEqual(errors, [], 'Browser JavaScript errors');
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'vadrouille-layout-desktop.png') });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
