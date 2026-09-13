#!/usr/bin/env node

/**
 * Repairs disconnected route-cache polylines.
 *
 * The script intentionally uses two different strategies:
 * - known short OSM branches are removed only when their segment index is
 *   explicitly listed below;
 * - every remaining gap is filled through the public OSM pedestrian router.
 *
 * It then stores one continuous polyline and rebuilds the distance offsets,
 * so the app and check-route-coherence.mjs use the same kilometre axis.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cliArgs = process.argv.slice(2);
const routeDirArgIndex = cliArgs.findIndex((value) => !value.startsWith("--"));
const routeDirArg = routeDirArgIndex >= 0 ? cliArgs[routeDirArgIndex] : null;
const ROUTE_CACHE_DIR = path.resolve(routeDirArg || "route-cache");
const GAP_THRESHOLD_METERS = 1000;
const MAX_CACHED_EDGE_METERS = 750;
const ROUTER_BASE_URL = "https://brouter.de/brouter";
const BRIDGE_CACHE_FILE = path.join(ROUTE_CACHE_DIR, ".gap-bridges.json");
const ROUTE_MANIFEST_FILE = path.join(path.dirname(ROUTE_CACHE_DIR), "gr-route-cache-manifest.js");

// These are the small disconnected branches identified from the OSM relation
// geometry. They are not route gaps and must not be connected by a made-up link.
const EXPLICIT_SEGMENT_REMOVALS = {
  GR14: [2],
  GR15: [4],
  GR16: [0],
  GR131: [1],
  GR655: [7, 8, 9, 10, 11, 12],
};

// The old broad OSM query appended unrelated/duplicate child members after the
// real GR34 route. Keep the main path plus the four later sections that are
// demonstrably continuations of it, then repair only the remaining gaps.
const EXPLICIT_SEGMENT_ORDERS = {
  GR34: [
    ...Array.from({ length: 18 }, (_, index) => index),
    175, 176, 177, 18, 19, 187, 20, 21,
  ],
};

const EXPLICIT_SEGMENT_REMOVAL_STARTS = {
  GR41: 5,
};

const args = cliArgs.filter((_, index) => index !== routeDirArgIndex);
const dryRun = args.includes("--dry-run");
const densifyOnly = args.includes("--densify");
const requestedRefs = new Set(
  args.filter((value) => !value.startsWith("--")).map(normalizeRef),
);

function normalizeRef(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function haversineMeters(a, b) {
  const radius = 6371008.8;
  const toRadians = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRadians;
  const dLon = (b[1] - a[1]) * toRadians;
  const lat1 = a[0] * toRadians;
  const lat2 = b[0] * toRadians;
  const x = dLon * Math.cos((lat1 + lat2) / 2);
  return radius * Math.sqrt(x * x + dLat * dLat);
}

function totalDistanceMeters(segments) {
  let total = 0;
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      total += haversineMeters(segment[index - 1], segment[index]);
    }
  }
  return total;
}

function pointOffsets(segment) {
  const offsets = [0];
  for (let index = 1; index < segment.length; index += 1) {
    offsets.push(offsets[index - 1] + haversineMeters(segment[index - 1], segment[index]));
  }
  return offsets;
}

function densifySegment(segment) {
  if (!Array.isArray(segment) || segment.length < 2) return segment;
  const densified = [[Number(segment[0][0].toFixed(6)), Number(segment[0][1].toFixed(6))]];

  for (let index = 1; index < segment.length; index += 1) {
    const start = segment[index - 1];
    const end = segment[index];
    const distance = haversineMeters(start, end);
    const steps = Math.max(1, Math.ceil(distance / MAX_CACHED_EDGE_METERS));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      densified.push([
        Number((start[0] + (end[0] - start[0]) * ratio).toFixed(6)),
        Number((start[1] + (end[1] - start[1]) * ratio).toFixed(6)),
      ]);
    }
  }
  return densified;
}

function interpolatePoint(distanceMeters, segment) {
  let remaining = Math.max(0, distanceMeters);
  for (let index = 1; index < segment.length; index += 1) {
    const start = segment[index - 1];
    const end = segment[index];
    const length = haversineMeters(start, end);
    if (remaining <= length) {
      const ratio = length > 0 ? remaining / length : 0;
      return [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ];
    }
    remaining -= length;
  }
  return segment.at(-1) || null;
}

function nearestPosition(point, segment) {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPosition = 0;
  let cumulative = 0;

  for (let index = 1; index < segment.length; index += 1) {
    const start = segment[index - 1];
    const end = segment[index];
    const segmentLength = haversineMeters(start, end);
    if (segmentLength <= 0) continue;

    const latScale = 111320;
    const lonScale = latScale * Math.cos(((start[0] + end[0]) / 2) * Math.PI / 180);
    const px = (point[1] - start[1]) * lonScale;
    const py = (point[0] - start[0]) * latScale;
    const dx = (end[1] - start[1]) * lonScale;
    const dy = (end[0] - start[0]) * latScale;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared > 0
      ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared))
      : 0;
    const projectedX = dx * ratio;
    const projectedY = dy * ratio;
    const distance = Math.hypot(px - projectedX, py - projectedY);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestPosition = cumulative + segmentLength * ratio;
    }
    cumulative += segmentLength;
  }

  return { distance: bestDistance, position: bestPosition };
}

function normalizeSegments(payload) {
  if (!Array.isArray(payload?.segments)) return [];
  return payload.segments.filter(
    (segment) => Array.isArray(segment) && segment.length >= 2,
  );
}

function removeExplicitBranches(ref, segments) {
  const indexes = new Set(EXPLICIT_SEGMENT_REMOVALS[ref] || []);
  const removalStart = EXPLICIT_SEGMENT_REMOVAL_STARTS[ref];
  if (Number.isInteger(removalStart)) {
    for (let index = removalStart; index < segments.length; index += 1) indexes.add(index);
  }
  if (!indexes.size) return { segments, removed: [] };

  const removed = [];
  const kept = [];
  segments.forEach((segment, index) => {
    if (indexes.has(index)) removed.push(index);
    else kept.push(segment);
  });
  return { segments: kept, removed };
}

function selectExplicitSegments(ref, segments) {
  const order = EXPLICIT_SEGMENT_ORDERS[ref];
  if (!Array.isArray(order)) return removeExplicitBranches(ref, segments);
  if (order.some((index) => index < 0 || index >= segments.length)) {
    throw new Error(`${ref}: ordre de segments explicite incompatible avec le cache`);
  }

  const used = new Set(order);
  return {
    segments: order.map((index) => segments[index]),
    removed: segments.map((_, index) => index).filter((index) => !used.has(index)),
  };
}

function bridgeCacheKey(from, to) {
  return `${from[0].toFixed(5)},${from[1].toFixed(5)}>${to[0].toFixed(5)},${to[1].toFixed(5)}`;
}

async function readBridgeCache() {
  try {
    const data = JSON.parse(await fs.readFile(BRIDGE_CACHE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function writeBridgeCache(cache) {
  await fs.writeFile(BRIDGE_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function readManifestTotals() {
  try {
    const raw = await fs.readFile(ROUTE_MANIFEST_FILE, "utf8");
    const jsonText = raw
      .replace(/^\s*window\.GR_ROUTE_CACHE_MANIFEST\s*=\s*/, "")
      .replace(/;\s*$/, "");
    const manifest = JSON.parse(jsonText);
    return new Map(
      Object.entries(manifest?.routes || {}).map(([ref, entry]) => [normalizeRef(ref), Number(entry?.totalKm)]),
    );
  } catch {
    return new Map();
  }
}

async function fetchPedestrianBridge(from, to, bridgeCache) {
  const key = bridgeCacheKey(from, to);
  if (Array.isArray(bridgeCache[key]) && bridgeCache[key].length >= 2) {
    return { points: bridgeCache[key], cached: true, distanceMeters: totalDistanceMeters([bridgeCache[key]]) };
  }

  const lonlats = `${from[1]},${from[0]}|${to[1]},${to[0]}`;
  const url = `${ROUTER_BASE_URL}?lonlats=${encodeURIComponent(lonlats)}&nogos=&profile=trekking&alternativeidx=0&format=geojson`;
  const response = await fetch(url, {
    headers: { "User-Agent": "la-petite-vadrouille-route-repair/1.0" },
  });
  if (!response.ok) {
    throw new Error(`routeur pédestre HTTP ${response.status} pour ${key}`);
  }

  const data = await response.json();
  const coordinatesGeoJson = data?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coordinatesGeoJson) || coordinatesGeoJson.length < 2) {
    throw new Error(`routeur pédestre sans géométrie pour ${key}`);
  }

  const points = coordinatesGeoJson
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([lon, lat]) => [Number(lat), Number(lon)])
    .filter((point) => point.every(Number.isFinite));
  if (points.length < 2) throw new Error(`géométrie pédestre invalide pour ${key}`);

  const endpointError = Math.max(
    haversineMeters(from, points[0]),
    haversineMeters(to, points.at(-1)),
  );
  if (endpointError > 100) {
    throw new Error(`routeur pédestre mal raccordé (${Math.round(endpointError)} m) pour ${key}`);
  }

  bridgeCache[key] = points;
  return {
    points,
    cached: false,
    distanceMeters: Number(data?.features?.[0]?.properties?.["track-length"]) || totalDistanceMeters([points]),
  };
}

function mergeWithBridge(left, bridge, right) {
  const merged = [...left];
  const bridgePoints = bridge.slice(1, -1);
  const rightPoints = right.slice(1);
  merged.push(...bridgePoints, ...rightPoints);
  return merged;
}

function buildCities(payload, newSegment) {
  if (!Array.isArray(payload?.cities) || !Array.isArray(payload?.segments)) return [];
  const oldSegments = normalizeSegments(payload);
  const newTotalKm = totalDistanceMeters([newSegment]) / 1000;

  // The route may have lost an explicitly identified branch. In that case,
  // cities beyond the new end belong to the removed branch and must disappear.
  // Once a cache has been repaired, preserve the already projected positions.
  if (payload.repair || oldSegments.length !== 1) {
    return payload.cities.filter((city) => {
      const km = Number(city?.km);
      return Number.isFinite(km) && km >= 0 && km <= newTotalKm + 0.1;
    });
  }

  const oldSegment = oldSegments[0];
  const newCities = [];
  for (const city of payload.cities) {
    const km = Number(city?.km);
    const name = String(city?.name || "").trim();
    if (!name || !Number.isFinite(km) || km < 0) continue;
    const oldPoint = interpolatePoint(km * 1000, oldSegment);
    if (!oldPoint) continue;
    const projection = nearestPosition(oldPoint, newSegment);
    if (!Number.isFinite(projection.position)) continue;
    newCities.push({
      name,
      place: String(city.place || "").trim(),
      km: Math.round(projection.position / 100) / 10,
    });
  }
  newCities.sort((left, right) => left.km - right.km || left.name.localeCompare(right.name, "fr"));
  return newCities;
}

function makePayload(payload, segment, source, bridges, removed) {
  const offsets = pointOffsets(segment).map((value) => Math.round(value * 10) / 10);
  const totalKm = Math.round(totalDistanceMeters([segment]) / 100) / 10;
  const updated = {
    ...payload,
    generatedAt: new Date().toISOString(),
    source: `${source || "OSM"} + routed foot bridges`,
    rawSegmentCount: 1,
    chainCount: 1,
    maxJoinGap: 0,
    totalKm,
    cities: buildCities(payload, segment),
    citiesSkipped: false,
    segmentPointMeters: [offsets],
    segments: [segment],
    repair: {
      removedSegments: removed,
      bridges: bridges.map((bridge) => ({
        from: bridge.from,
        to: bridge.to,
        distanceMeters: Math.round(bridge.distanceMeters),
        cached: bridge.cached,
        router: ROUTER_BASE_URL,
      })),
    },
  };
  return updated;
}

async function repairRoute(routePath, bridgeCache) {
  const payload = JSON.parse(await fs.readFile(routePath, "utf8"));
  const ref = normalizeRef(payload.ref || path.basename(routePath, ".json"));
  let segments = normalizeSegments(payload);
  const explicit = payload.repair
    ? { segments, removed: [] }
    : selectExplicitSegments(ref, segments);
  segments = explicit.segments;
  if (!segments.length) throw new Error(`${ref}: aucun segment après nettoyage`);

  const gaps = [];
  for (let index = 1; index < segments.length; index += 1) {
    const gap = haversineMeters(segments[index - 1].at(-1), segments[index][0]);
    if (gap > GAP_THRESHOLD_METERS) {
      gaps.push({ index, gap });
    }
  }

  if (dryRun) {
    return { ref, changed: explicit.removed.length > 0 || gaps.length > 0, removed: explicit.removed, gaps };
  }

  const bridges = [];
  let merged = [...segments[0]];
  for (let index = 1; index < segments.length; index += 1) {
    const right = segments[index];
    const from = merged.at(-1);
    const to = right[0];
    const gap = haversineMeters(from, to);
    if (gap > GAP_THRESHOLD_METERS) {
      const bridge = await fetchPedestrianBridge(from, to, bridgeCache);
      bridges.push({ from, to, ...bridge });
      merged = mergeWithBridge(merged, bridge.points, right);
    } else if (gap <= 1e-6) {
      merged.push(...right.slice(1));
    } else {
      merged.push(...right);
    }
  }

  const updated = makePayload(payload, merged, payload.source, bridges, explicit.removed);
  await fs.writeFile(routePath, `${JSON.stringify(updated)}\n`, "utf8");
  return { ref, changed: true, removed: explicit.removed, gaps, bridges };
}

async function densifyRoute(routePath, manifestTotals) {
  const payload = JSON.parse(await fs.readFile(routePath, "utf8"));
  const ref = normalizeRef(payload.ref || path.basename(routePath, ".json"));
  const segments = normalizeSegments(payload).map(densifySegment);
  if (!segments.length) throw new Error(`${path.basename(routePath)}: aucun segment exploitable`);

  const geometryOffsets = segments.map((segment) => pointOffsets(segment));
  const geometryTotalMeters = geometryOffsets.reduce(
    (sum, offsets) => sum + (offsets.at(-1) || 0),
    0,
  );
  const targetTotalKm = manifestTotals.get(ref) ?? Number(payload.totalKm);
  const targetTotalMeters = Number.isFinite(targetTotalKm) ? targetTotalKm * 1000 : geometryTotalMeters;
  const scale = geometryTotalMeters > 0 && Number.isFinite(targetTotalMeters)
    ? targetTotalMeters / geometryTotalMeters
    : 1;
  const scaledOffsets = geometryOffsets.map((offsets) => (
    offsets.map((value) => Math.round(value * scale * 1000) / 1000)
  ));
  if (scaledOffsets.length && scaledOffsets.at(-1)?.length && Number.isFinite(targetTotalMeters)) {
    const previousTotal = scaledOffsets.slice(0, -1).reduce(
      (sum, offsets) => sum + (offsets.length ? Number(offsets.at(-1)) || 0 : 0),
      0,
    );
    const lastOffsets = scaledOffsets.at(-1);
    lastOffsets[lastOffsets.length - 1] = Math.round((targetTotalMeters - previousTotal) * 10) / 10;
  }

  const updated = {
    ...payload,
    generatedAt: new Date().toISOString(),
    totalKm: Number.isFinite(targetTotalKm) ? targetTotalKm : Math.round(totalDistanceMeters(segments) / 100) / 10,
    segmentPointMeters: scaledOffsets,
    segments,
  };
  await fs.writeFile(routePath, `${JSON.stringify(updated)}\n`, "utf8");
  return { ref: normalizeRef(payload.ref || path.basename(routePath, ".json")), changed: true, gaps: [] };
}

async function main() {
  const entries = (await fs.readdir(ROUTE_CACHE_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => !requestedRefs.size || requestedRefs.has(normalizeRef(name.slice(0, -5))))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const bridgeCache = await readBridgeCache();
  const manifestTotals = await readManifestTotals();
  const results = [];
  for (const entry of entries) {
    const result = densifyOnly
      ? await densifyRoute(path.join(ROUTE_CACHE_DIR, entry), manifestTotals)
      : await repairRoute(path.join(ROUTE_CACHE_DIR, entry), bridgeCache);
    results.push(result);
    if (result.changed) {
      const gapCount = result.gaps?.length || 0;
      const label = densifyOnly ? "points densifiés" : `${result.removed?.length || 0} branche(s) supprimée(s), ${gapCount} coupure(s) traitée(s)`;
      console.log(`${result.ref}: ${label}`);
    }
  }

  if (!dryRun) await writeBridgeCache(bridgeCache);
  const remaining = dryRun
    ? results.reduce((sum, result) => sum + (result.gaps?.length || 0), 0)
    : 0;
  console.log(JSON.stringify({ routes: results.length, changed: results.filter((result) => result.changed).length, remaining }, null, 2));
  if (remaining > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
