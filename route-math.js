/* Shared, dependency-free route calculations, also exercised by the Node tests. */
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;
  const R = 6371000;
  const indexes = new WeakMap();

  function distance(a, b) {
    const h = Math.sin((b[0] - a[0]) * RAD / 2) ** 2
      + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin((b[1] - a[1]) * RAD / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  function project(point, a, b) {
    const scale = Math.cos(point[0] * RAD);
    const dx = (b[1] - a[1]) * scale;
    const dy = b[0] - a[0];
    const px = (point[1] - a[1]) * scale;
    const py = point[0] - a[0];
    const length = dx * dx + dy * dy;
    const ratio = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
    return {
      ratio,
      distanceMeters: Math.hypot(px - ratio * dx, py - ratio * dy) * RAD * R,
      latlng: [a[0] + ratio * dy, a[1] + ratio * (b[1] - a[1])]
    };
  }

  function buildGeometry(segments, offsets) {
    let totalMeters = 0;
    const gaps = [];
    const records = segments.map((latlngs, index) => {
      if (index) {
        const gap = distance(segments[index - 1].at(-1), latlngs[0]);
        if (gap > 30) gaps.push({ meters: totalMeters, distanceMeters: gap, from: segments[index - 1].at(-1), to: latlngs[0] });
      }
      const pointOffsets = offsets?.[index] || [0];
      if (!offsets?.[index]) for (let i = 1; i < latlngs.length; i++) {
        pointOffsets.push(pointOffsets[i - 1] + distance(latlngs[i - 1], latlngs[i]));
      }
      const lengthMeters = pointOffsets.at(-1);
      const record = { latlngs, pointOffsets, lengthMeters, startMeters: totalMeters, endMeters: totalMeters + lengthMeters };
      totalMeters += lengthMeters;
      return record;
    });
    return { segments: records, totalMeters, gaps };
  }

  // Bounding boxes of short runs avoid projecting onto every edge at every GPS update.
  // No artificial edge is introduced between separate source segments.
  function buildIndex(geometry) {
    if (indexes.has(geometry)) return indexes.get(geometry);
    const chunks = [];
    for (const segment of geometry.segments) {
      for (let from = 1; from < segment.latlngs.length; from += 64) {
        const to = Math.min(from + 64, segment.latlngs.length);
        let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
        for (let i = from - 1; i < to; i++) {
          const p = segment.latlngs[i];
          south = Math.min(south, p[0]); north = Math.max(north, p[0]);
          west = Math.min(west, p[1]); east = Math.max(east, p[1]);
        }
        chunks.push({ segment, from, to, south, north, west, east });
      }
    }
    indexes.set(geometry, chunks);
    return chunks;
  }

  function nearest(point, geometry, range = null) {
    let best = { distanceMeters: Infinity, meters: 0, latlng: null };
    if (!geometry) return best;
    const lonScale = Math.cos(point[0] * RAD);
    const lower = range ? Math.min(...range) : -Infinity;
    const upper = range ? Math.max(...range) : Infinity;
    for (const box of buildIndex(geometry)) {
      const s = box.segment;
      if (s.startMeters + s.pointOffsets[box.to - 1] < lower || s.startMeters + s.pointOffsets[box.from - 1] > upper) continue;
      const dy = Math.max(box.south - point[0], 0, point[0] - box.north);
      const dx = Math.max(box.west - point[1], 0, point[1] - box.east) * lonScale;
      if (Math.hypot(dx, dy) * RAD * R > best.distanceMeters) continue;
      for (let i = box.from; i < box.to; i++) {
        const begin = s.startMeters + s.pointOffsets[i - 1];
        const length = s.pointOffsets[i] - s.pointOffsets[i - 1];
        if (length <= 0 || begin + length < lower || begin > upper) continue;
        let match = project(point, s.latlngs[i - 1], s.latlngs[i]);
        const ratio = Math.max(0, (lower - begin) / length, Math.min(1, (upper - begin) / length, match.ratio));
        if (ratio !== match.ratio) {
          const a = s.latlngs[i - 1], b = s.latlngs[i];
          const p = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
          match = { ratio, latlng: p, distanceMeters: distance(point, p) };
        }
        if (match.distanceMeters < best.distanceMeters) best = { ...match, meters: begin + length * match.ratio };
      }
    }
    return best;
  }

  function gapsBetween(geometry, a, b) {
    // Both sides of a missing junction share the same distance offset. Treat its
    // boundary conservatively, since that offset alone cannot identify the side.
    return Math.abs(a - b) < 1 ? [] : (geometry.gaps || []).filter(gap => gap.meters >= Math.min(a, b) && gap.meters <= Math.max(a, b));
  }

  function progress(geometry, position, target, start = null, now = Date.now(), previousMeters = null) {
    if (!position || now - position.timestamp > 30000) return { state: 'stale' };
    const accuracy = position.coords.accuracy;
    if (!Number.isFinite(accuracy) || accuracy > 100) return { state: 'inaccurate' };
    const point = [position.coords.latitude, position.coords.longitude];
    let match = nearest(point, geometry, start === null ? null : [start, target]);
    // At a crossing or on parallel paths, GPS noise must not jump kilometres ahead.
    // Prefer the nearby part of the previous fix only when it is equally plausible.
    if (Number.isFinite(previousMeters) && Math.abs(match.meters - previousMeters) > 250) {
      const from = Math.max(start === null ? 0 : Math.min(start, target), previousMeters - 250);
      const to = Math.min(start === null ? geometry.totalMeters : Math.max(start, target), previousMeters + 250);
      if (from <= to) {
        const local = nearest(point, geometry, [from, to]);
        if (local.distanceMeters <= match.distanceMeters + Math.max(10, accuracy)) match = local;
      }
    }
    if (!match.latlng) return { state: 'unavailable' };
    if (match.distanceMeters > Math.max(50, accuracy * 2)) return { state: 'off-route', ...match };
    if (gapsBetween(geometry, match.meters, target).length) return { state: 'gap', ...match };
    const remainingMeters = Math.abs(target - match.meters);
    return { state: remainingMeters <= 30 && match.distanceMeters <= 30 ? 'arrived' : 'tracking', remainingMeters, ...match };
  }

  const api = { distance, project, buildGeometry, nearest, gapsBetween, progress };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RouteMath = api;
})(globalThis);
