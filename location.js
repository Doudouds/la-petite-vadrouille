(function () {
  'use strict';
  const native = Boolean(window.Capacitor?.isNativePlatform());
  // This app uses plain scripts: Android injects Plugins, without the bundled registerPlugin helper.
  const plugin = native ? (window.Capacitor.Plugins?.Geolocation || window.Capacitor.registerPlugin?.('Geolocation')) : null;
  const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000, minimumUpdateInterval: 5000 };

  async function permission() {
    if (native && !plugin) throw new Error('Le module de localisation est indisponible. Mettez l’application à jour.');
    if (!plugin) {
      if (!navigator.geolocation) throw new Error('La localisation n’est pas disponible sur cet appareil.');
      return;
    }
    let result = await plugin.checkPermissions();
    if (result.location === 'prompt' || result.location === 'prompt-with-rationale') {
      result = await plugin.requestPermissions({ permissions: ['location'] });
    }
    if (result.location !== 'granted' && result.coarseLocation !== 'granted') {
      const error = new Error('Autorisez la localisation dans les paramètres de l’application pour réessayer.');
      error.code = 1;
      throw error;
    }
  }

  function errorMessage(error) {
    const code = String(error?.code || '');
    if (['1', 'OS-PLUG-GLOC-0003'].includes(code)) return 'Localisation refusée. Vous pouvez l’autoriser dans les paramètres puis réessayer.';
    if (['3', 'OS-PLUG-GLOC-0010'].includes(code)) return 'Position introuvable pour le moment. Réessayez à l’extérieur.';
    if (['2', 'OS-PLUG-GLOC-0002', 'OS-PLUG-GLOC-0007', 'OS-PLUG-GLOC-0009'].includes(code)) return 'Position indisponible. Vérifiez que la localisation du téléphone est activée.';
    return error?.message || 'La localisation est indisponible. Vous pouvez continuer avec la carte.';
  }

  async function current() {
    await permission();
    return plugin ? plugin.getCurrentPosition(options) : new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
  }

  // Return a synchronous stop handle, including while permission / native watch creation is pending.
  function watch(onPosition, onError) {
    let stopped = false, watchId = null;
    // Allow a cold GPS fix to settle without slowing the desired update cadence.
    const watchOptions = { ...options, timeout: 30000, interval: 5000, maximumAge: 0 };
    const clear = id => plugin ? plugin.clearWatch({ id }).catch(() => {}) : navigator.geolocation.clearWatch(id);
    (async () => {
      try {
        await permission();
        if (stopped) return;
        const success = position => { if (!stopped) onPosition(position); };
        const failure = error => { if (!stopped) onError(error); };
        watchId = plugin
          ? await plugin.watchPosition(watchOptions, (position, error) => error ? failure(error) : position && success(position))
          : navigator.geolocation.watchPosition(success, failure, watchOptions);
        if (stopped) clear(watchId);
      } catch (error) { if (!stopped) onError(error); }
    })();
    return () => { stopped = true; if (watchId !== null) { clear(watchId); watchId = null; } };
  }

  window.VadrouilleLocation = { current, watch, errorMessage, native };
})();
