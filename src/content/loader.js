/**
 * src/content/loader.js
 *
 * The ONLY classic (non-module) script in the extension, and the only thing
 * the manifest injects as a content script. Chrome MV3 does NOT support
 * "type": "module" on manifest-declared content_scripts, but dynamic
 * import() of a web-accessible module URL works — this shim is what makes a
 * bundler-free ES-module content script possible.
 *
 * Guards against double-injection (e.g. the extension re-injecting on
 * navigation, or a dev reload) via a window symbol, then dynamically
 * imports src/content/main.js inside a try/catch so a failure here never
 * breaks the host page.
 */

(function bootCadenceLoader() {
  const GUARD_KEY = '__cadenceLoaderInjected__';

  if (window[GUARD_KEY]) {
    return;
  }
  window[GUARD_KEY] = true;

  try {
    const mainUrl = chrome.runtime.getURL('src/content/main.js');
    import(mainUrl).catch((err) => {
      console.error('[cadence:loader] failed to import main.js', err);
    });
  } catch (err) {
    console.error('[cadence:loader] failed to boot', err);
  }
})();
