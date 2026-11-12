const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../location.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a watch stopped while native registration is pending is cleared when it resolves', async () => {
  let resolveId, callback, cleared = [];
  const plugin = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: (_, cb) => { callback = cb; return new Promise(resolve => { resolveId = resolve; }); },
    clearWatch: async ({ id }) => { cleared.push(id); }
  };
  const window = { Capacitor: { isNativePlatform: () => true, Plugins: { Geolocation: plugin } } };
  vm.runInNewContext(source, { window });
  let updates = 0;
  const stop = window.VadrouilleLocation.watch(() => updates++, () => {});
  await tick(); stop(); resolveId('pending'); await tick();
  callback({ coords: {} });
  assert.deepEqual(cleared, ['pending']);
  assert.equal(updates, 0);
});
test('permission denial never starts a native GPS watcher', async () => {
  let started = false, error;
  const plugin = { checkPermissions: async () => ({ location: 'denied', coarseLocation: 'denied' }), watchPosition: () => { started = true; } };
  const window = { Capacitor: { isNativePlatform: () => true, Plugins: { Geolocation: plugin } } };
  vm.runInNewContext(source, { window });
  window.VadrouilleLocation.watch(() => {}, e => { error = e; }); await tick();
  assert.equal(started, false); assert.equal(error.code, 1);
});
test('approximate Android permission remains usable for nearby discovery', async () => {
  const plugin = { checkPermissions: async () => ({ location: 'denied', coarseLocation: 'granted' }), getCurrentPosition: async () => ({ coords: { accuracy: 500 } }) };
  const window = { Capacitor: { isNativePlatform: () => true, Plugins: { Geolocation: plugin } } };
  vm.runInNewContext(source, { window });
  assert.equal((await window.VadrouilleLocation.current()).coords.accuracy, 500);
});
