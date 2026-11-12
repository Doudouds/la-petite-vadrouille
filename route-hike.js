window.createHikeController = function ({ map, renderer, state, chooseStart, openArrival, closePlanner, slice }) {
  const locate = document.getElementById('hike-locate');
  const stopButton = document.getElementById('hike-stop');
  const center = document.getElementById('hike-center');
  const message = document.getElementById('hike-message');
  const progressCard = document.getElementById('hike-progress');
  const remaining = document.getElementById('hike-remaining');
  const destination = document.getElementById('hike-destination');
  const startButton = document.getElementById('hike-start');
  const locationButton = document.getElementById('planner-location');
  const locationMessage = document.getElementById('planner-location-message');
  const locationToast = document.getElementById('planner-location-toast');
  const positionLayer = L.layerGroup().addTo(map);
  const remainingLayer = L.layerGroup().addTo(map);
  let stopWatch = null, wanted = false, active = !document.hidden, position = null;
  let marker = null, accuracyCircle = null, following = false, lastSliceKey = '', ageTimer = null, retryTimer = null;
  let locationRequest = 0, locationToastTimer;
  let previousMeters = null, selectionKey = '';
  const access = RouteAccess.createController({ map, geometry: () => state.routeGeometry, beforeFit: () => { following = false; } });

  function say(text) { message.textContent = text; message.hidden = !text; }
  function clearLocationToast() {
    clearTimeout(locationToastTimer);
    locationToast.textContent = '';
  }
  function clearRemaining() { remainingLayer.clearLayers(); lastSliceKey = ''; }
  function updateProgress() {
    const target = state.endSelection;
    progressCard.hidden = !wanted || !target;
    if (!wanted || !active || !position || !state.routeGeometry) { clearRemaining(); return; }
    if (!target) { say('Position affichée. Choisissez votre prochaine arrivée pour voir la distance restante.'); clearRemaining(); return; }
    destination.textContent = `jusqu’à ${target.name}`;
    const keyForSelection = `${state.startSelection?.meters}:${target.meters}`;
    if (selectionKey !== keyForSelection) previousMeters = null;
    selectionKey = keyForSelection;
    const result = RouteMath.progress(state.routeGeometry, position, target.meters, state.startSelection?.meters ?? null, Date.now(), previousMeters);
    remaining.textContent = '—';
    if (result.state === 'tracking' || result.state === 'arrived') {
      previousMeters = result.meters;
      remaining.textContent = result.state === 'arrived' ? 'Arrivée !' : `${(result.remainingMeters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
      say(result.state === 'arrived' ? 'Vous êtes à proximité de votre arrivée.' : `Restants sur le sentier · précision GPS ±${Math.round(position.coords.accuracy)} m`);
      const key = `${Math.round(result.meters / 15)}:${target.meters}`;
      if (key !== lastSliceKey) {
        clearRemaining(); lastSliceKey = key;
        L.polyline(slice(state.routeGeometry, result.meters, target.meters), { color: '#dc762e', weight: 7, opacity: 0.9, interactive: false, renderer }).addTo(remainingLayer);
      }
    } else {
      clearRemaining();
      say({
        stale: 'Signal GPS ancien. En attente d’une nouvelle position…',
        inaccurate: 'Position trop imprécise. Attendez un meilleur signal pour calculer les kilomètres restants.',
        'off-route': `Vous êtes à environ ${Math.round(result.distanceMeters || 0)} m de l’étape. Rejoignez le tracé pour reprendre le calcul.`,
        gap: 'Le tracé présente une interruption avant l’arrivée. Distance restante indisponible sur cette portion.',
        unavailable: 'La distance restante est indisponible.'
      }[result.state]);
    }
  }

  function receive(next) {
    if (!next?.coords || !Number.isFinite(next.coords.latitude) || !Number.isFinite(next.coords.longitude)) return;
    position = next;
    access.update(next);
    const latlng = [next.coords.latitude, next.coords.longitude];
    if (!marker) {
      accuracyCircle = L.circle(latlng, { radius: next.coords.accuracy, color: '#2563eb', fillColor: '#3b82f6', weight: 1, fillOpacity: 0.12, interactive: false, renderer }).addTo(positionLayer);
      marker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, renderer }).bindTooltip('Vous êtes ici').addTo(positionLayer);
    } else {
      marker.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng).setRadius(next.coords.accuracy);
    }
    center.hidden = false;
    if (following) map.setView(latlng, Math.max(14, map.getZoom()), { animate: false });
    updateProgress();
    marker.bringToFront();
    if (!state.endSelection) say(`Votre position · précision ±${Math.round(next.coords.accuracy)} m. Préparez une arrivée pour suivre votre étape.`);
    clearTimeout(ageTimer);
    ageTimer = setTimeout(() => {
      access.update(position);
      updateProgress();
      if (!state.endSelection && wanted) say('Signal GPS ancien. En attente d’une nouvelle position…');
    }, 31000);
  }

  function suspend() {
    access.pause();
    if (stopWatch) stopWatch();
    stopWatch = null;
    clearTimeout(ageTimer);
    clearTimeout(retryTimer);
    position = null;
    previousMeters = null;
    positionLayer.clearLayers(); marker = accuracyCircle = null;
    center.hidden = true;
    clearRemaining(); remaining.textContent = '—';
  }

  function resume() {
    if (!wanted || !active || stopWatch) return;
    say('Recherche du signal GPS…');
    stopWatch = VadrouilleLocation.watch(receive, error => {
      suspend();
      // A temporary loss of signal must not end a hike. Native errors can release the
      // callback, so restart the watcher; stop/background also cancels this retry.
      if (['2', '3', 'OS-PLUG-GLOC-0002', 'OS-PLUG-GLOC-0010'].includes(String(error?.code))) {
        say('Signal GPS perdu. Nouvelle recherche en cours…');
        retryTimer = setTimeout(resume, 5000);
        return;
      }
      wanted = false;
      locate.hidden = false; stopButton.hidden = true; progressCard.hidden = true;
      say(VadrouilleLocation.errorMessage(error));
    });
  }

  function start() {
    if (!state.routeGeometry) { say('Attendez le chargement du tracé.'); return; }
    wanted = true; following = true;
    locate.hidden = true; stopButton.hidden = false;
    closePlanner(); resume();
    if (position) { map.setView(marker.getLatLng(), Math.max(14, map.getZoom())); updateProgress(); }
  }

  function stop() {
    wanted = false; suspend();
    locate.hidden = false; stopButton.hidden = true; progressCard.hidden = true;
    say('Localisation arrêtée.');
  }

  locate.addEventListener('click', start);
  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', stop);
  center.addEventListener('click', () => { following = true; if (position) map.setView(marker.getLatLng(), Math.max(14, map.getZoom())); });
  map.on('dragstart', () => { following = false; });
  document.getElementById('hike-target').addEventListener('click', openArrival);
  window.addEventListener('route-selection-change', updateProgress);
  window.addEventListener('route-ready', () => { locate.disabled = false; locationButton.disabled = false; });
  locate.disabled = locationButton.disabled = !state.routeGeometry;

  locationButton.addEventListener('click', async () => {
    const request = ++locationRequest;
    clearLocationToast();
    locationButton.disabled = true; locationMessage.hidden = false;
    locationMessage.textContent = 'Recherche de votre position…';
    try {
      const current = await VadrouilleLocation.current();
      if (request !== locationRequest || !active) return;
      if (current.coords.accuracy > 100) throw new Error('Position trop imprécise. Réessayez à l’extérieur ou choisissez le départ sur la carte.');
      const match = RouteMath.nearest([current.coords.latitude, current.coords.longitude], state.routeGeometry);
      locationMessage.hidden = true;
      if (match.distanceMeters > Math.max(50, current.coords.accuracy * 2)) {
        locationToast.textContent = 'Vous êtes trop loin du tracé. Rejoignez la randonnée pour partir de votre position.';
        locationToastTimer = setTimeout(clearLocationToast, 6000);
        return;
      }
      chooseStart(match);
    } catch (error) {
      if (request === locationRequest) {
        locationMessage.textContent = VadrouilleLocation.errorMessage(error);
        locationMessage.hidden = false;
      }
    }
    finally { if (request === locationRequest) locationButton.disabled = false; }
  });

  function visibility(isActive) {
    active = isActive;
    if (!active) {
      locationRequest++; locationButton.disabled = !state.routeGeometry; locationMessage.hidden = true;
      clearLocationToast();
      suspend(); if (wanted) say('GPS en pause pendant que l’application est en arrière-plan.');
    } else resume();
  }
  document.addEventListener('visibilitychange', () => visibility(!document.hidden));
  window.addEventListener('app-visibility', event => visibility(event.detail.isActive));
  window.addEventListener('pagehide', () => { locationRequest++; wanted = false; suspend(); });
};
