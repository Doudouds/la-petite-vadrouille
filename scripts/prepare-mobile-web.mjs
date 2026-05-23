import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const stageDir = path.join(rootDir, 'mobile-web');
const leafletDistDir = path.join(rootDir, 'node_modules', 'leaflet', 'dist');

const appEntries = [
  'index.html',
  'gr.html',
  'style.css',
  'index.js',
  'data.js',
  'gr-metadata.js',
  'region-geometry.js',
  'gr-region-cache.js',
  'gr-route-cache-manifest.js',
  'stations-sncf.js',
  'logo.png',
  'site-logo.svg',
  'manifest.webmanifest',
  'pwa.js',
  'sw.js',
  'offline.html',
  'privacy.html',
  'route-cache'
];

function resolveFromRoot(relativePath) {
  return path.join(rootDir, relativePath);
}

function resolveFromStage(relativePath) {
  return path.join(stageDir, relativePath);
}

async function copyEntry(relativePath) {
  const source = resolveFromRoot(relativePath);
  const target = resolveFromStage(relativePath);
  await cp(source, target, { recursive: true, force: true });
}

async function stageLeaflet() {
  const vendorDir = resolveFromStage(path.join('vendor', 'leaflet'));
  await mkdir(vendorDir, { recursive: true });
  await cp(path.join(leafletDistDir, 'leaflet.css'), path.join(vendorDir, 'leaflet.css'), { force: true });
  await cp(path.join(leafletDistDir, 'leaflet.js'), path.join(vendorDir, 'leaflet.js'), { force: true });
  await cp(path.join(leafletDistDir, 'images'), path.join(vendorDir, 'images'), { recursive: true, force: true });
}

async function rewriteGrPage() {
  const grPagePath = resolveFromStage('gr.html');
  let html = await readFile(grPagePath, 'utf8');
  html = html.replace(
    /<link rel="stylesheet" href="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.css"[\s\S]*?crossorigin="" \/>/,
    '<link rel="stylesheet" href="vendor/leaflet/leaflet.css" />'
  );
  html = html.replace(
    /<script src="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js"[\s\S]*?crossorigin=""><\/script>/,
    '<script src="vendor/leaflet/leaflet.js"></script>'
  );
  await writeFile(grPagePath, html, 'utf8');
}

async function writeBuildInfo() {
  const manifestPath = resolveFromRoot('gr-route-cache-manifest.js');
  const manifestText = await readFile(manifestPath, 'utf8');
  const routeCountMatch = manifestText.match(/"count":(\d+)/);
  const buildInfo = {
    preparedAt: new Date().toISOString(),
    routeCount: routeCountMatch ? Number(routeCountMatch[1]) : null,
    leafletBundled: true
  };
  await writeFile(resolveFromStage('mobile-build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
}

async function main() {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  for (const entry of appEntries) {
    await copyEntry(entry);
  }

  await stageLeaflet();
  await rewriteGrPage();
  await writeBuildInfo();

  console.log(`Mobile web bundle prepared in ${stageDir}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});