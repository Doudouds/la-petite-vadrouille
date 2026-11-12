const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../pwa.js'), 'utf8');

test('plain-script native bridge handles back, modal cancellation and lifecycle', () => {
  const callbacks = {};
  const navigations = [];
  const location = { pathname: '/gr.html', protocol: 'https:', replace: path => navigations.push(path) };
  const window = new EventTarget();
  window.navigator = {};
  window.scrollTo = () => navigations.push('scroll');
  window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener(name, callback) { callbacks[name] = callback; return { remove: async () => {} }; } } } };
  const document = { querySelectorAll: () => [], body: { classList: { toggle() {} } } };
  vm.runInNewContext(source, { window, location, document, navigator: {}, Event, CustomEvent, console });
  callbacks.backButton();
  assert.deepEqual(navigations, ['index.html']);
  location.pathname = '/index.html'; callbacks.backButton();
  assert.deepEqual(navigations, ['index.html', 'scroll']);
  window.addEventListener('app-back', event => event.preventDefault(), { once: true });
  callbacks.backButton();
  assert.equal(navigations.length, 2);
  let active;
  window.addEventListener('app-visibility', event => { active = event.detail.isActive; });
  callbacks.appStateChange({ isActive: false });
  assert.equal(active, false);
});
