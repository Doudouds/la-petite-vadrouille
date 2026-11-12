const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildGeometry, distance } = require('../route-math');

function audit(t, segments, mutate = () => {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'vadrouille-audit-'));
  t.after(() => {
    if (!path.resolve(dir).startsWith(tempRoot + path.sep)) throw new Error('Unexpected temporary directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const geometry = buildGeometry(segments);
  const payload = {
    ref: 'GRTEST', rawSegmentCount: segments.length, chainCount: 1,
    maxJoinGap: segments.length > 1 ? distance(segments[0].at(-1), segments[1][0]) : 0,
    totalKm: geometry.totalMeters / 1000, cities: [], citiesSkipped: true,
    segments, segmentPointMeters: geometry.segments.map(s => s.pointOffsets)
  };
  mutate(payload);
  fs.writeFileSync(path.join(dir, 'GRTEST.json'), JSON.stringify(payload));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/check-route-coherence.mjs'), dir, '--json'], { encoding: 'utf8' });
  return { exit: result.status, result: JSON.parse(result.stdout).results[0] };
}

test('audit distinguishes a long continuous edge from an unrecorded junction', t => {
  const continuous = audit(t, [[[48, 2], [48.005, 2]]]);
  assert.equal(continuous.exit, 0); assert.equal(continuous.result.status, 'ok');
  const broken = audit(t, [[[48, 2], [48.001, 2]], [[48.002, 2], [48.003, 2]]]);
  assert.equal(broken.exit, 0); assert.equal(broken.result.status, 'warning');
  assert.equal(broken.result.issues.filter(i => i.boundary).length, 1);
});
test('audit fails on jumps within a line and inconsistent cumulative distances', t => {
  const jump = audit(t, [[[48, 2], [48.02, 2]]]);
  assert.equal(jump.exit, 1);
  assert(jump.result.issues.some(i => i.code === 'segments.disconnected'));
  const shortened = audit(t, [[[48, 2], [48.001, 2]]], data => { data.segmentPointMeters[0][1] = 10; data.totalKm = 0.01; });
  assert.equal(shortened.exit, 1);
  assert(shortened.result.issues.some(i => i.code === 'offsets.short'));
});
