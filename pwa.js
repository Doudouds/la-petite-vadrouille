(function () {
  const installButtons = Array.from(document.querySelectorAll('[data-action="install-app"]'));
  const displayModeMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)')
    : null;
  let deferredPrompt = null;

  function isNativeShell() {
    return Boolean(
      window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform()
    );
  }

  function isStandalone() {
    return isNativeShell() || Boolean(window.navigator.standalone) || Boolean(displayModeMedia && displayModeMedia.matches);
  }

  function updateInstallButtons() {
    const shouldShow = Boolean(deferredPrompt) && !isStandalone();
    document.body.classList.toggle('app-installed', isStandalone());
    installButtons.forEach(button => {
      button.hidden = !shouldShow;
      button.disabled = !shouldShow;
    });
  }

  async function installApp() {
    if (!deferredPrompt) {
      return;
    }

    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    updateInstallButtons();

    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch (error) {
      console.warn('PWA install prompt failed.', error);
    }
  }

  installButtons.forEach(button => {
    button.addEventListener('click', installApp);
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    updateInstallButtons();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    updateInstallButtons();
  });

  if (displayModeMedia && typeof displayModeMedia.addEventListener === 'function') {
    displayModeMedia.addEventListener('change', updateInstallButtons);
  }

  updateInstallButtons();

  if (!isNativeShell() && 'serviceWorker' in navigator && /^https?:$/i.test(window.location.protocol)) {
    const registerServiceWorker = () => {
      navigator.serviceWorker.register('./sw.js').catch(error => {
        console.warn('Service worker registration failed.', error);
      });
    };

    if (document.readyState === 'complete') {
      registerServiceWorker();
    } else {
      window.addEventListener('load', registerServiceWorker, { once: true });
    }
  }
})();