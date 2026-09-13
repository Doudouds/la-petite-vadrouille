import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_MAX_JOIN_GAP_METERS = 1000;
const MAX_COORDINATE_LATITUDE = 90;
const MAX_COORDINATE_LONGITUDE = 180;
const EPSILON_METERS = 0.001;

function usage() {
  console.log([
    'Usage: node ./scripts/check-route-coherence.mjs [route-cache-dir] [options]',
    '',
    'Options:',
    '  --json                 écrit le rapport complet au format JSON',
    '  --max-gap <mètres>     seuil de rupture entre deux segments (défaut: 1000)',
    '  --help                 affiche cette aide'
  ].join('\n'));
}

function parseArguments(argv) {
  let routeDir = path.join(rootDir, 'route-cache');
  let routeDirProvided = false;
  let jsonOutput = false;
  let maxJoinGapMeters = DEFAULT_MAX_JOIN_GAP_METERS;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }

    if (argument === '--json') {
      jsonOutput = true;
      continue;
    }

    if (argument === '--max-gap') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--max-gap doit être un nombre positif ou nul.');
      }
      maxJoinGapMeters = value;
      continue;
    }

    if (argument.startsWith('--')) {
      throw new Error(`Option inconnue: ${argument}`);
    }

    if (routeDirProvided) {
      throw new Error('Un seul dossier de caches peut être fourni.');
    }
    routeDir = path.resolve(process.cwd(), argument);
    routeDirProvided = true;
  }

  return { routeDir, jsonOutput, maxJoinGapMeters };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCoordinate(value) {
  return Array.isArray(value)
    && value.length === 2
    && isFiniteNumber(value[0])
    && isFiniteNumber(value[1])
    && Math.abs(value[0]) <= MAX_COORDINATE_LATITUDE
    && Math.abs(value[1]) <= MAX_COORDINATE_LONGITUDE;
}

function haversineMeters(left, right) {
  const radiusMeters = 6371000;
  const toRadians = Math.PI / 180;
  const lat1 = left[0] * toRadians;
  const lat2 = right[0] * toRadians;
  const deltaLat = (right[0] - left[0]) * toRadians;
  const deltaLon = (right[1] - left[1]) * toRadians;
  const arc = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusMeters * Math.asin(Math.sqrt(Math.min(1, arc)));
}

function formatMeters(value) {
  if (!isFiniteNumber(value)) {
    return 'n/a';
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} km`;
  }
  return `${Math.round(value)} m`;
}

function formatKm(value) {
  return isFiniteNumber(value) ? `${value.toFixed(1)} km` : 'n/a';
}

function addIssue(issues, severity, code, message, details = {}) {
  issues.push({ severity, code, message, ...details });
}

function validateSegments(payload, issues, maxJoinGapMeters) {
  const segments = payload.segments;
  const pointMeters = payload.segmentPointMeters;

  if (!Array.isArray(segments) || segments.length === 0) {
    addIssue(issues, 'error', 'segments.empty', 'aucun segment exploitable');
    return { cachedTotalMeters: 0, observedMaxJoinGapMeters: 0, joinGaps: [] };
  }

  if (!Array.isArray(pointMeters) || pointMeters.length !== segments.length) {
    addIssue(
      issues,
      'error',
      'offsets.count',
      `segmentPointMeters doit contenir ${segments.length} tableau(x)`,
      { expected: segments.length, actual: Array.isArray(pointMeters) ? pointMeters.length : null }
    );
  }

  let cachedTotalMeters = 0;
  const joinGaps = [];
  const internalGapThresholdMeters = maxJoinGapMeters;

  segments.forEach((segment, segmentIndex) => {
    if (!Array.isArray(segment) || segment.length < 2) {
      addIssue(
        issues,
        'error',
        'segments.shape',
        `segment ${segmentIndex} doit contenir au moins 2 points`,
        { segmentIndex }
      );
      return;
    }

    segment.forEach((point, pointIndex) => {
      if (!isCoordinate(point)) {
        addIssue(
          issues,
          'error',
          'segments.coordinate',
          `coordonnée invalide au segment ${segmentIndex}, point ${pointIndex}`,
          { segmentIndex, pointIndex }
        );
      }
    });

    for (let pointIndex = 1; pointIndex < segment.length; pointIndex++) {
      const previousPoint = segment[pointIndex - 1];
      const currentPoint = segment[pointIndex];
      if (!isCoordinate(previousPoint) || !isCoordinate(currentPoint)) {
        continue;
      }

      const gapMeters = haversineMeters(previousPoint, currentPoint);
      if (gapMeters > internalGapThresholdMeters) {
        addIssue(
          issues,
          'error',
          'segments.disconnected',
          `rupture de ${formatMeters(gapMeters)} dans le segment ${segmentIndex}, entre les points ${pointIndex - 1} et ${pointIndex}`,
          { segmentIndex, pointIndex, gapMeters, internal: true, thresholdMeters: internalGapThresholdMeters }
        );
      }
    }

    const offsets = Array.isArray(pointMeters?.[segmentIndex])
      ? pointMeters[segmentIndex]
      : null;
    if (!offsets) {
      return;
    }

    if (offsets.length !== segment.length) {
      addIssue(
        issues,
        'error',
        'offsets.length',
        `segment ${segmentIndex}: ${offsets.length} distance(s) pour ${segment.length} point(s)`,
        { segmentIndex, expected: segment.length, actual: offsets.length }
      );
      return;
    }

    if (offsets.length > 0 && offsets[0] !== 0) {
      addIssue(
        issues,
        'error',
        'offsets.start',
        `segment ${segmentIndex}: la distance cumulée doit commencer à 0`,
        { segmentIndex, actual: offsets[0] }
      );
    }

    let previousOffset = 0;
    offsets.forEach((offset, pointIndex) => {
      if (!isFiniteNumber(offset) || offset < 0) {
        addIssue(
          issues,
          'error',
          'offsets.value',
          `distance invalide au segment ${segmentIndex}, point ${pointIndex}`,
          { segmentIndex, pointIndex, actual: offset }
        );
        return;
      }

      if (pointIndex > 0 && offset + EPSILON_METERS < previousOffset) {
        addIssue(
          issues,
          'error',
          'offsets.order',
          `segment ${segmentIndex}: les kilomètres reculent au point ${pointIndex}`,
          { segmentIndex, pointIndex, previousOffset, actual: offset }
        );
      }
      previousOffset = offset;
    });

    const segmentEndMeters = offsets.at(-1);
    if (isFiniteNumber(segmentEndMeters)) {
      cachedTotalMeters += segmentEndMeters;
    }
  });

  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!Array.isArray(previous) || !Array.isArray(current) || previous.length < 2 || current.length < 2) {
      continue;
    }

    const previousEnd = previous.at(-1);
    const currentStart = current[0];
    if (!isCoordinate(previousEnd) || !isCoordinate(currentStart)) {
      continue;
    }

    const gapMeters = haversineMeters(previousEnd, currentStart);
    joinGaps.push({
      segmentIndex: index,
      meters: gapMeters,
      exceedsThreshold: gapMeters > maxJoinGapMeters
    });

    if (gapMeters > maxJoinGapMeters) {
      addIssue(
        issues,
        'warning',
        'segments.disconnected',
        `rupture de ${formatMeters(gapMeters)} entre les segments ${index - 1} et ${index}`,
        { segmentIndex: index, gapMeters, boundary: true }
      );
    }
  }

  return {
    cachedTotalMeters,
    observedMaxJoinGapMeters: Math.max(0, ...joinGaps.map(join => join.meters)),
    joinGaps
  };
}

function validateCities(payload, issues, totalKm) {
  if (!Array.isArray(payload.cities)) {
    addIssue(issues, 'error', 'cities.shape', 'cities doit être un tableau');
    return;
  }

  if (payload.cities.length === 0 && payload.citiesSkipped !== true) {
    addIssue(issues, 'warning', 'cities.empty', 'aucune ville n’est enregistrée');
  }

  let previousKm = 0;
  payload.cities.forEach((city, cityIndex) => {
    const km = city?.km;
    if (!city || typeof city.name !== 'string' || !isFiniteNumber(km) || km < 0) {
      addIssue(
        issues,
        'error',
        'cities.value',
        `repère de ville invalide à l’index ${cityIndex}`,
        { cityIndex, actual: city }
      );
      return;
    }

    if (cityIndex > 0 && km + 0.0001 < previousKm) {
      addIssue(
        issues,
        'error',
        'cities.order',
        `les kilomètres des villes reculent entre ${payload.cities[cityIndex - 1].name} et ${city.name}`,
        { cityIndex, previousKm, actual: km }
      );
    }

    if (isFiniteNumber(totalKm) && km > totalKm + 0.15) {
      addIssue(
        issues,
        'error',
        'cities.range',
        `${city.name} est positionnée à ${formatKm(km)}, au-delà du tracé (${formatKm(totalKm)})`,
        { cityIndex, km, totalKm }
      );
    }
    previousKm = Math.max(previousKm, km);
  });
}

function validatePayload(payload, fileName, maxJoinGapMeters) {
  const issues = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    addIssue(issues, 'error', 'payload.shape', 'le fichier doit contenir un objet JSON');
    return { issues, stats: {} };
  }

  const expectedRef = path.basename(fileName, '.json').toUpperCase();
  if (payload.ref !== expectedRef) {
    addIssue(
      issues,
      'error',
      'payload.ref',
      `ref=${String(payload.ref)} ne correspond pas au fichier ${expectedRef}.json`,
      { expected: expectedRef, actual: payload.ref }
    );
  }

  if (!isFiniteNumber(payload.totalKm) || payload.totalKm < 0) {
    addIssue(issues, 'error', 'payload.totalKm', 'totalKm doit être un nombre positif ou nul');
  }

  if (!Number.isInteger(payload.rawSegmentCount) || payload.rawSegmentCount < 1) {
    addIssue(issues, 'error', 'payload.rawSegmentCount', 'rawSegmentCount doit être un entier positif');
  }

  if (!Number.isInteger(payload.chainCount) || payload.chainCount < 1) {
    addIssue(issues, 'error', 'payload.chainCount', 'chainCount doit être un entier positif');
  } else if (payload.chainCount > 1) {
    addIssue(
      issues,
      'warning',
      'payload.chains',
      `le tracé est composé de ${payload.chainCount} chaînes séparées (elles sont dessinées sans liaison artificielle)`,
      { chainCount: payload.chainCount }
    );
  }

  if (!isFiniteNumber(payload.maxJoinGap) || payload.maxJoinGap < 0) {
    addIssue(issues, 'error', 'payload.maxJoinGap', 'maxJoinGap doit être un nombre positif ou nul');
  }

  const geometry = validateSegments(payload, issues, maxJoinGapMeters);
  const totalKmFromOffsets = geometry.cachedTotalMeters / 1000;
  if (isFiniteNumber(payload.totalKm) && Math.abs(payload.totalKm - totalKmFromOffsets) > 0.15) {
    addIssue(
      issues,
      'error',
      'payload.totalKmMismatch',
      `totalKm=${formatKm(payload.totalKm)} mais les distances cumulées donnent ${formatKm(totalKmFromOffsets)}`,
      { declaredTotalKm: payload.totalKm, calculatedTotalKm: totalKmFromOffsets }
    );
  }

  if (isFiniteNumber(payload.maxJoinGap)
      && Math.abs(payload.maxJoinGap - geometry.observedMaxJoinGapMeters) > 25) {
    addIssue(
      issues,
      'warning',
      'payload.maxJoinGapMismatch',
      `maxJoinGap=${formatMeters(payload.maxJoinGap)} mais le fichier donne ${formatMeters(geometry.observedMaxJoinGapMeters)}`,
      { declaredMaxJoinGapMeters: payload.maxJoinGap, calculatedMaxJoinGapMeters: geometry.observedMaxJoinGapMeters }
    );
  }

  validateCities(payload, issues, payload.totalKm);

  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;
  return {
    issues,
    status: errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ok',
    stats: {
      segments: Array.isArray(payload.segments) ? payload.segments.length : 0,
      cities: Array.isArray(payload.cities) ? payload.cities.length : 0,
      totalKm: payload.totalKm,
      calculatedTotalKm: totalKmFromOffsets,
      maxJoinGapMeters: geometry.observedMaxJoinGapMeters,
      chainCount: payload.chainCount
    }
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readExpectedRefs() {
  const routesPath = path.join(rootDir, 'cache-routes.json');
  if (!existsSync(routesPath)) {
    return null;
  }

  const routes = readJson(routesPath);
  if (!Array.isArray(routes)) {
    return null;
  }
  return new Set(routes.map(route => String(route?.ref || '').replace(/\s+/g, '').toUpperCase()).filter(Boolean));
}

function readManifestRefs() {
  const manifestPath = path.join(rootDir, 'gr-route-cache-manifest.js');
  if (!existsSync(manifestPath)) {
    return null;
  }

  const source = readFileSync(manifestPath, 'utf8');
  const match = source.match(/window\.GR_ROUTE_CACHE_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) {
    return null;
  }

  const manifest = JSON.parse(match[1]);
  return manifest?.routes && typeof manifest.routes === 'object'
    ? new Set(Object.keys(manifest.routes).map(ref => ref.toUpperCase()))
    : null;
}

function compareReferenceSets(results, routeDir, expectedRefs, manifestRefs) {
  const actualRefs = new Set(results.map(result => result.ref));
  const addMissing = (refs, code, label) => {
    if (!refs) {
      return;
    }
    for (const ref of refs) {
      if (!actualRefs.has(ref)) {
        results.push({
          ref,
          file: path.join(routeDir, `${ref}.json`),
          status: 'error',
          issues: [{
            severity: 'error',
            code,
            message: `${label} ${ref} mais le fichier de cache est absent`
          }],
          stats: {}
        });
      }
    }
  };

  addMissing(expectedRefs, 'cache.missing', 'randonnée attendue');
  addMissing(manifestRefs, 'manifest.missing', 'randonnée présente dans le manifeste');
}

function loadResults(routeDir, maxJoinGapMeters) {
  if (!existsSync(routeDir)) {
    throw new Error(`Dossier introuvable: ${routeDir}`);
  }

  const files = readdirSync(routeDir)
    .filter(fileName => fileName.toLowerCase().endsWith('.json') && !fileName.startsWith('.'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (files.length === 0) {
    throw new Error(`Aucun fichier JSON trouvé dans ${routeDir}`);
  }

  const results = files.map(fileName => {
    const filePath = path.join(routeDir, fileName);
    try {
      const payload = readJson(filePath);
      const checked = validatePayload(payload, fileName, maxJoinGapMeters);
      return { ref: String(payload?.ref || path.basename(fileName, '.json')).toUpperCase(), file: filePath, ...checked };
    } catch (error) {
      return {
        ref: path.basename(fileName, '.json').toUpperCase(),
        file: filePath,
        status: 'error',
        issues: [{
          severity: 'error',
          code: 'file.invalidJson',
          message: error instanceof Error ? error.message : String(error)
        }],
        stats: {}
      };
    }
  });

  const defaultRouteDir = path.resolve(rootDir, 'route-cache');
  const isProjectRouteDir = path.resolve(routeDir) === defaultRouteDir;
  compareReferenceSets(
    results,
    routeDir,
    isProjectRouteDir ? readExpectedRefs() : null,
    isProjectRouteDir ? readManifestRefs() : null
  );
  return results.sort((left, right) => left.ref.localeCompare(right.ref, undefined, { numeric: true }));
}

function printHumanReport(results, routeDir, maxJoinGapMeters) {
  const errorRoutes = results.filter(result => result.status === 'error');
  const warningRoutes = results.filter(result => result.status === 'warning');
  const okRoutes = results.filter(result => result.status === 'ok');

  console.log(`Contrôle des tracés: ${routeDir}`);
  console.log(`Seuil de rupture: ${formatMeters(maxJoinGapMeters)}`);
  console.log(`Randonnées analysées: ${results.length}`);
  console.log(`Résultat: ${okRoutes.length} OK, ${warningRoutes.length} avertissement(s), ${errorRoutes.length} erreur(s)`);

  for (const result of results.filter(item => item.status !== 'ok')) {
    console.log(`\n${result.status === 'error' ? 'ERREUR' : 'AVERTISSEMENT'} ${result.ref}`);
    const groupedIssues = new Map();
    for (const issue of result.issues) {
      if (!groupedIssues.has(issue.code)) {
        groupedIssues.set(issue.code, []);
      }
      groupedIssues.get(issue.code).push(issue);
    }

    for (const [code, issues] of groupedIssues) {
      if (code === 'segments.disconnected' && issues.length > 1) {
        const maxGap = Math.max(...issues.map(issue => issue.gapMeters));
        console.log(`  - [${code}] ${issues.length} rupture(s), maximum ${formatMeters(maxGap)}`);
        issues.slice(0, 3).forEach(issue => console.log(`      ${issue.message}`));
        if (issues.length > 3) {
          console.log(`      … ${issues.length - 3} autre(s), voir --json pour le détail`);
        }
        continue;
      }

      issues.forEach(issue => console.log(`  - [${code}] ${issue.message}`));
    }
  }

  if (errorRoutes.length === 0) {
    console.log('\nTous les tracés respectent les contrôles de cohérence.');
  } else {
    console.log('\nLe contrôle échoue: corrigez les randonnées signalées avant de considérer les caches cohérents.');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = loadResults(options.routeDir, options.maxJoinGapMeters);
  if (options.jsonOutput) {
    console.log(JSON.stringify({
      routeDir: options.routeDir,
      maxJoinGapMeters: options.maxJoinGapMeters,
      checkedAt: new Date().toISOString(),
      results
    }, null, 2));
  } else {
    printHumanReport(results, options.routeDir, options.maxJoinGapMeters);
  }

  process.exitCode = results.some(result => result.status === 'error') ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`Erreur: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Utilisez --help pour afficher la syntaxe.');
  process.exitCode = 1;
}
