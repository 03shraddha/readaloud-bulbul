// Browser-side harness for the edge-* fixtures: stands in for the chrome.*
// APIs so src/content/main.js can run on a plain http page. Serve the repo
// root (python3 -m http.server), open a fixture, then from the console:
//   const {MSG,TARGET,makeEnvelope} = await import('/src/shared/messages.js');
//   __boyle.deliver(makeEnvelope(MSG.ACTIVATE, TARGET.CONTENT, 's1', {}));
//   __boyle.sent  // every message main.js sent, START_READING included
(() => {
  const sent = [];
  let listener = null;
  window.__boyle = {
    sent,
    deliver: (env) => listener && listener(env, {}, () => {}),
  };
  window.chrome = {
    runtime: {
      getURL: (path) => `/${path}`,
      sendMessage: async (env) => {
        sent.push(env);
      },
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {} },
    },
  };
  import('/src/content/main.js');
})();
