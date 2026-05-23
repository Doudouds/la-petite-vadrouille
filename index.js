(function () {
  const ROUTE_METADATA = window.GR_ROUTE_METADATA || {};
  const ROUTE_CACHE_MANIFEST = window.GR_ROUTE_CACHE_MANIFEST?.routes || {};
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const regionStatus = document.getElementById('region-status');
  const resultsMeta = document.getElementById('results-meta');
  const clearRegionButton = document.getElementById('clear-region');
  const regionMap = document.getElementById('region-map');

  const REGION_DEFS = window.FRANCE_REGION_DEFS || [];
  const REGION_CACHE = window.GR_REGION_CACHE?.regions || {};

  const state = {
    search: '',
    selectedRegionCode: null,
    regionRefs: null,
    isLoadingRegion: false,
    regionCache: new Map(
      Object.entries(REGION_CACHE).map(([regionCode, refs]) => [
        regionCode,
        new Set((refs || []).map(normalizeRef))
      ])
    )
  };

  function normalizeRef(ref) {
    return String(ref || '').replace(/\s+/g, '').toUpperCase();
  }

  function enrichRoute(gr) {
    const meta = ROUTE_METADATA[normalizeRef(gr.ref)] || {};
    const displayName = meta.displayName || gr.nom;
    const summary = meta.summary || gr.description;
    return {
      ...gr,
      refKey: normalizeRef(gr.ref),
      displayName,
      summary,
      searchText: [gr.ref, gr.nom, displayName, gr.description, summary].join(' ').toLowerCase()
    };
  }

  function getRouteSourceList() {
    const manifestRoutes = Object.entries(ROUTE_CACHE_MANIFEST).map(([ref, route]) => ({
      ref,
      nom: route.displayName || ref,
      description: route.summary || ''
    }));

    return manifestRoutes.length ? manifestRoutes : GR_LIST;
  }

  const baseRoutes = Array.from(
    new Map(getRouteSourceList().map(gr => [normalizeRef(gr.ref), enrichRoute(gr)])).values()
  );

  function setRegionStatus(message, isError = false) {
    regionStatus.textContent = message;
    regionStatus.classList.toggle('error', isError);
  }

  function getSelectedRegion() {
    return REGION_DEFS.find(region => region.code === state.selectedRegionCode) || null;
  }

  function renderRegionMap() {
    if (!REGION_DEFS.length) {
      regionMap.innerHTML = '';
      return;
    }

    regionMap.innerHTML = `
      <defs>
        <linearGradient id="seaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#e8f5ff"></stop>
          <stop offset="55%" stop-color="#c7e0fb"></stop>
          <stop offset="100%" stop-color="#b8d2f0"></stop>
        </linearGradient>
        <radialGradient id="coastGlow" cx="42%" cy="36%" r="70%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.92)"></stop>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"></stop>
        </radialGradient>
      </defs>
      <rect class="map-sea" x="0" y="0" width="360" height="500" rx="24"></rect>
      <rect class="map-coast-glow" x="16" y="14" width="328" height="472" rx="28"></rect>
      <g class="map-landmass" aria-hidden="true">
        ${REGION_DEFS.map(region => `
          <path class="fr-region-backdrop" d="${region.path}"></path>
        `).join('')}
      </g>
      ${REGION_DEFS.map(region => `
      <g class="region-group" data-region-code="${region.code}" tabindex="0" role="button" aria-label="Filtrer sur ${region.name}" style="--region-fill: ${region.color}">
        <path class="fr-region${state.selectedRegionCode === region.code ? ' active' : ''}" d="${region.path}"></path>
        <text class="fr-region-label" x="${region.labelX}" y="${region.labelY}">${region.code}</text>
      </g>
    `).join('')}`;

    regionMap.querySelectorAll('.region-group').forEach(node => {
      node.addEventListener('click', () => toggleRegion(node.dataset.regionCode));
      node.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleRegion(node.dataset.regionCode);
        }
      });
    });
  }

  function toggleRegion(regionCode) {
    if (state.selectedRegionCode === regionCode) {
      state.selectedRegionCode = null;
      state.regionRefs = null;
      setRegionStatus('Cliquez sur une région pour filtrer la liste depuis le cache local.');
      renderRegionMap();
      render();
      return;
    }

    const region = REGION_DEFS.find(entry => entry.code === regionCode);
    if (!region) {
      return;
    }

    state.selectedRegionCode = regionCode;
    renderRegionMap();

    if (!state.regionCache.has(regionCode)) {
      state.selectedRegionCode = null;
      state.regionRefs = null;
      setRegionStatus(`Aucun cache local trouvé pour ${region.name}.`, true);
      renderRegionMap();
      render();
      return;
    }

    state.regionRefs = state.regionCache.get(regionCode);
    setRegionStatus(`${state.regionRefs.size} GR repérés dans ${region.name} (cache local).`);
    render();
  }

  function render() {
    const searchText = state.search.trim().toLowerCase();
    const selectedRegion = getSelectedRegion();
    const filteredRoutes = baseRoutes.filter(route => {
      if (searchText && !route.searchText.includes(searchText)) {
        return false;
      }
      if (selectedRegion && state.regionRefs && !state.regionRefs.has(route.refKey)) {
        return false;
      }
      return true;
    });

    grid.innerHTML = '';

    filteredRoutes.forEach(route => {
      const card = document.createElement('a');
      card.className = 'gr-card';
      card.href = `gr.html?ref=${encodeURIComponent(route.ref)}&nom=${encodeURIComponent(route.displayName)}`;
      card.innerHTML = `
        <span class="ref">${route.ref}</span>
        <h2>${route.displayName}</h2>
        <p>${route.summary}</p>
      `;
      grid.appendChild(card);
    });

    if (!filteredRoutes.length) {
      grid.innerHTML = '<div class="empty-state">Aucun GR ne correspond au filtre actuel.</div>';
    }

    const parts = [`${filteredRoutes.length} GR affiché${filteredRoutes.length > 1 ? 's' : ''}`];
    if (selectedRegion) {
      parts.push(`région : ${selectedRegion.name}`);
    }
    resultsMeta.textContent = parts.join(' • ');
  }

  search.addEventListener('input', event => {
    state.search = event.target.value;
    render();
  });

  clearRegionButton.addEventListener('click', () => {
    state.selectedRegionCode = null;
    state.regionRefs = null;
    setRegionStatus('Cliquez sur une région pour filtrer la liste depuis le cache local.');
    renderRegionMap();
    render();
  });

  setRegionStatus(
    state.regionCache.size
      ? 'Cliquez sur une région pour filtrer la liste depuis le cache local.'
      : 'Le cache local des régions n\'est pas encore disponible.',
    !state.regionCache.size
  );
  renderRegionMap();
  render();
})();