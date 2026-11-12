const { test } = require('node:test');
const assert = require('node:assert/strict');
const { routingUrl, mapsUrl, parseRoute, positionProblem } = require('../route-access');
const origin = [48.005, 1.99], target = [48.005, 2];
const response = coordinates => ({ features: [{ geometry: { type: 'LineString', coordinates }, properties: { 'total-time': '600' } }] });

test('access routing uses a pedestrian profile and longitude/latitude order', () => {
  const url = new URL(routingUrl(origin, target));
  assert.equal(url.hostname, 'brouter.de');
  assert.equal(url.searchParams.get('profile'), 'hiking-beta');
  assert.equal(url.searchParams.get('lonlats'), '1.990000,48.005000|2.000000,48.005000');
  const maps = new URL(mapsUrl(target));
  assert.equal(maps.searchParams.get('destination'), '48.005,2');
  assert.equal(maps.searchParams.get('travelmode'), 'walking');
  assert.equal(maps.searchParams.has('origin'), false);
});
test('access geometry retains turns and measures the returned path', () => {
  const route = parseRoute(response([[1.99, 48.005], [1.99, 48.006], [2, 48.006], [2, 48.005]]), origin, target);
  assert.equal(route.latlngs.length, 4);
  assert(route.meters > 900 && route.meters < 1100);
  assert.equal(route.minutes, 10);
  assert.equal(route.startGap, 0); assert.equal(route.endGap, 0);
});
test('wrong destination, invalid or missing geometry are never drawn as an approach', () => {
  assert.throws(() => parseRoute(response([[1.99, 48.005], [2.01, 48.005]]), origin, target), /accès piéton/);
  assert.throws(() => parseRoute(response([[1.99, 48.005], [NaN, 48]]), origin, target), /exploitable/);
  assert.throws(() => parseRoute({ features: [] }, origin, target), /exploitable/);
});
test('old and approximate GPS fixes cannot start an access route', () => {
  assert.match(positionProblem({ timestamp: Date.now() - 31000, coords: { accuracy: 5 } }), /récente/);
  assert.match(positionProblem({ timestamp: Date.now(), coords: { accuracy: 500 } }), /imprécise/);
  assert.equal(positionProblem({ timestamp: Date.now(), coords: { accuracy: 5 } }), '');
});
