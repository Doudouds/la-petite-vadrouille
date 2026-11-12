const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const math = require('../route-math');
const geometry = math.buildGeometry([[[48, 2], [48.01, 2], [48.01, 2.01]]]);
const position = (lat, lon, accuracy = 5, timestamp = Date.now()) => ({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp });

test('remaining distance follows a bend, not a straight line', () => {
  const result = math.progress(geometry, position(48, 2), geometry.totalMeters, 0);
  assert.equal(result.state, 'tracking');
  assert(result.remainingMeters > math.distance([48, 2], [48.01, 2.01]) + 400);
});
test('reverse direction uses the same route axis', () => {
  const result = math.progress(geometry, position(48.01, 2.005), 0, geometry.totalMeters);
  assert.equal(result.state, 'tracking');
  assert(Math.abs(result.remainingMeters - (geometry.segments[0].pointOffsets[1] + geometry.segments[0].lengthMeters) / 2) < 1);
});
test('arrival, off-route, stale and inaccurate fixes are distinct states', () => {
  assert.equal(math.progress(geometry, position(48.01, 2.01), geometry.totalMeters).state, 'arrived');
  assert.equal(math.progress(geometry, position(48.1, 2.1), geometry.totalMeters).state, 'off-route');
  assert.equal(math.progress(geometry, position(48, 2, 5, Date.now() - 31000), geometry.totalMeters).state, 'stale');
  assert.equal(math.progress(geometry, position(48, 2, 1000), geometry.totalMeters).state, 'inaccurate');
});
test('separate segments are never joined into a fictitious route', () => {
  const disconnected = math.buildGeometry([[[48, 2], [48.001, 2]], [[48.01, 2], [48.02, 2]]]);
  assert.equal(disconnected.gaps.length, 1);
  assert.equal(math.progress(disconnected, position(48, 2), disconnected.totalMeters).state, 'gap');
  assert(math.nearest([48.005, 2], disconnected).distanceMeters > 400);
  assert.equal(math.progress(disconnected, position(48.015, 2), disconnected.totalMeters).state, 'tracking');
});
test('selected interval prevents a jump to an unrelated side of a loop', () => {
  const loop = math.buildGeometry([[[48, 2], [48.01, 2], [48.01, 2.01], [48, 2.01], [48, 2]]]);
  const start = loop.segments[0].pointOffsets[2], end = loop.totalMeters;
  const match = math.nearest([48, 2], loop, [start, end]);
  assert.equal(match.meters, loop.totalMeters);
});
test('provided kilometre offsets survive projection', () => {
  const source = math.buildGeometry([[[48, 2], [48.01, 2]]], [[0, 1500]]);
  assert(Math.abs(math.nearest([48.005, 2], source).meters - 750) < 0.01);
});
test('GPS noise at a crossing keeps continuity with the previous fix', () => {
  const crossing = math.buildGeometry([[[48, 2], [48.01, 2.01], [48, 2.01], [48.01, 2]]]);
  const middleOfLastLeg = (crossing.segments[0].pointOffsets[2] + crossing.totalMeters) / 2;
  const result = math.progress(crossing, position(48.005, 2.005), crossing.totalMeters, 0, Date.now(), middleOfLastLeg - 15);
  assert.equal(result.state, 'tracking');
  assert(Math.abs(result.meters - middleOfLastLeg) < 1);
});
test('bounded projection clamps at the actual destination within an edge', () => {
  const match = math.nearest([48.01, 2], geometry, [100, 200]);
  assert.equal(match.meters, 200);
});
test('spatial pruning agrees with a full edge scan on every cached route', () => {
  const dir = path.resolve(__dirname, '../route-cache');
  for (const file of fs.readdirSync(dir).filter(f => /^GR.*\.json$/.test(f))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file)));
    const route = math.buildGeometry(data.segments, data.segmentPointMeters);
    const sample = data.segments[Math.floor(data.segments.length / 2)];
    const point = sample[Math.floor(sample.length / 2)].map(n => n + 0.0001);
    let min = Infinity;
    for (const segment of route.segments) for (let i = 1; i < segment.latlngs.length; i++) {
      if (segment.pointOffsets[i] <= segment.pointOffsets[i - 1]) continue;
      min = Math.min(min, math.project(point, segment.latlngs[i - 1], segment.latlngs[i]).distanceMeters);
    }
    assert(Math.abs(math.nearest(point, route).distanceMeters - min) < 0.001, file);
  }
});
