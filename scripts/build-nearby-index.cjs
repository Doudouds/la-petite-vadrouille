// A small, deterministic search-only index. Detailed navigation always uses route-cache.
const fs = require('node:fs');
const path = require('node:path');
const { distance, project } = require('../route-math.js');
const root = path.resolve(__dirname, '..');
const toleranceMeters = 75;

function simplify(points) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let max = toleranceMeters, selected = 0;
    for (let i = first + 1; i < last; i++) {
      const d = project(points[i], points[first], points[last]).distanceMeters;
      if (d > max) { max = d; selected = i; }
    }
    if (selected) { keep[selected] = 1; stack.push([first, selected], [selected, last]); }
  }
  return points.filter((_, i) => keep[i]).map(p => p.map(n => Number(n.toFixed(5))));
}

const routes = {};
for (const file of fs.readdirSync(path.join(root, 'route-cache')).filter(f => /^GR.+\.json$/.test(f)).sort()) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'route-cache', file), 'utf8'));
  const chains = [];
  for (const segment of data.segments) {
    const previous = chains.at(-1);
    if (previous && distance(previous.at(-1), segment[0]) < 1) {
      for (let i = 1; i < segment.length; i++) previous.push(segment[i]);
    } else chains.push(segment.slice());
  }
  routes[data.ref] = chains.map(simplify);
}
const content = JSON.stringify({ toleranceMeters, routes }) + '\n';
const target = path.join(root, 'nearby-routes.json');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) throw new Error('Nearby index is stale. Run npm run routes:index.');
} else fs.writeFileSync(target, content);
console.log(`Nearby index: ${Object.keys(routes).length} routes, ${Math.round(Buffer.byteLength(content) / 1024)} KiB, ±${toleranceMeters} m geometry tolerance.`);
