(function (root) {
  'use strict';
  const math = root.RouteMath || (typeof require === 'function' ? require('./route-math.js') : null);
  const ENDPOINT_TOLERANCE = 50;

  function routingUrl(origin, target) {
    const url = new URL('https://brouter.de/brouter');
    url.search = new URLSearchParams({
      lonlats: [origin, target].map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join('|'),
      profile: 'hiking-beta', alternativeidx: '0', format: 'geojson'
    });
    return url.href;
  }

  function mapsUrl(target) {
    return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: target.join(','), travelmode: 'walking' })}`;
  }

  function parseRoute(data, origin, target) {
    const feature = data?.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 2
      || coordinates.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
      throw new Error('Le service n’a pas fourni de trajet piéton exploitable.');
    }
    const latlngs = coordinates.map(([lon, lat]) => [lat, lon]);
    const startGap = math.distance(origin, latlngs[0]);
    const endGap = math.distance(target, latlngs.at(-1));
    if (startGap > ENDPOINT_TOLERANCE || endGap > ENDPOINT_TOLERANCE) {
      throw new Error('Aucun accès piéton suffisamment proche de ce point du sentier n’a été trouvé.');
    }
    // Use only the returned path. Never invent a straight connector to the GPS fix or GR.
    const meters = latlngs.slice(1).reduce((sum, p, i) => sum + math.distance(latlngs[i], p), 0);
    if (meters < 1) throw new Error('Le trajet calculé est trop court pour être exploitable.');
    const seconds = Number(feature.properties?.['total-time']);
    return { latlngs, meters, startGap, endGap, minutes: Math.max(1, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : meters / (4000 / 3600)) / 60)) };
  }

  function positionProblem(position) {
    if (!position || !Number.isFinite(position.timestamp) || Date.now() - position.timestamp > 30000) return 'Attendez une position GPS récente pour calculer l’approche.';
    if (!Number.isFinite(position.coords?.accuracy) || position.coords.accuracy > 100) return 'Position trop imprécise pour calculer l’approche. Attendez un meilleur signal.';
    return '';
  }

  function createController({ map, geometry, beforeFit }) {
    const container = document.getElementById('route-access');
    const button = document.getElementById('access-calculate');
    const clearButton = document.getElementById('access-clear');
    const status = document.getElementById('access-status');
    const external = document.getElementById('access-maps');
    const layer = L.featureGroup().addTo(map);
    const routeRenderer = L.svg();
    let position = null, request = 0, controller = null, origin = null, timer = null;
    const idleText = 'Approche à pied · votre position est envoyée à BRouter pour ce calcul en ligne.';

    function clear() {
      request++;
      controller?.abort(); controller = null;
      clearTimeout(timer);
      layer.clearLayers(); origin = null;
      external.hidden = true; external.removeAttribute('href');
      clearButton.hidden = true; clearButton.textContent = 'Effacer';
      button.disabled = Boolean(positionProblem(position));
      button.textContent = 'Itinéraire vers le sentier';
      status.textContent = idleText;
    }

    function update(next) {
      position = next;
      container.hidden = !position;
      const problem = positionProblem(position);
      if (problem) { clear(); button.disabled = true; status.textContent = problem; return; }
      const point = [position.coords.latitude, position.coords.longitude];
      if (origin && math.distance(origin, point) > 100) {
        clear(); status.textContent = 'Vous avez changé de position. Recalculez l’approche depuis votre emplacement actuel.';
      } else if (button.disabled && !controller) status.textContent = idleText;
      button.disabled = Boolean(controller);
    }

    button.addEventListener('click', async () => {
      const problem = positionProblem(position);
      if (problem) { update(position); return; }
      clear();
      origin = [position.coords.latitude, position.coords.longitude];
      const target = math.nearest(origin, geometry());
      if (!target.latlng) { status.textContent = 'Attendez le chargement du sentier.'; return; }
      external.href = mapsUrl(target.latlng); external.hidden = false;
      clearButton.hidden = false;
      L.circleMarker(target.latlng, { radius: 8, color: '#a44912', fillColor: '#ffcb8e', fillOpacity: 1, weight: 3 })
        .bindTooltip('Point du sentier le plus proche').addTo(layer);
      if (target.distanceMeters <= 30) {
        status.textContent = 'Vous êtes déjà à proximité du sentier (moins de 30 m).';
        return;
      }
      const requestId = ++request;
      const abort = new AbortController(); controller = abort;
      button.disabled = true; button.textContent = 'Calcul en cours…'; clearButton.textContent = 'Annuler';
      status.textContent = 'Recherche d’un accès à pied vers le point le plus proche du sentier…';
      timer = setTimeout(() => abort.abort(), 25000);
      try {
        const response = await fetch(routingUrl(origin, target.latlng), {
          signal: abort.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
        });
        if (!response.ok) throw new Error('Le service de calcul est temporairement indisponible.');
        const data = await response.json();
        if (requestId !== request) return;
        const route = parseRoute(data, origin, target.latlng);
        const problemNow = positionProblem(position);
        if (problemNow) { clear(); status.textContent = problemNow; return; }
        L.polyline(route.latlngs, { color: '#e87822', weight: 6, opacity: 0.95, dashArray: '9 6', renderer: routeRenderer, className: 'access-route-line' })
          .bindTooltip('Approche à pied vers le sentier').addTo(layer);
        const km = (route.meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
        const gaps = Math.round(route.startGap + route.endGap);
        status.textContent = `${km} km d’approche · environ ${route.minutes} min à pied. Tracé orange pointillé : BRouter / OpenStreetMap.${gaps > 10 ? ` Environ ${gaps} m de raccords aux extrémités restent à vérifier.` : ''}`;
        button.textContent = 'Recalculer l’itinéraire';
        beforeFit();
        map.fitBounds(layer.getBounds().extend(origin), { padding: [24, 24], maxZoom: 16 });
      } catch (error) {
        if (requestId !== request) return;
        status.textContent = `${error.name === 'AbortError' ? 'Le calcul prend trop de temps.' : error instanceof TypeError ? 'Connexion indisponible pour calculer l’approche.' : error.message} Réessayez ou ouvrez ce point dans Google Maps.`;
        button.textContent = 'Réessayer l’itinéraire';
      } finally {
        if (requestId === request) {
          clearTimeout(timer); controller = null;
          button.disabled = Boolean(positionProblem(position)); clearButton.textContent = 'Effacer';
        }
      }
    });
    clearButton.addEventListener('click', clear);
    return { update, pause() { position = null; clear(); container.hidden = true; } };
  }

  const api = { routingUrl, mapsUrl, parseRoute, positionProblem, createController };
  root.RouteAccess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
