// Preloaded by run-offline-tests.mjs: an offline test may only call a loopback server it started itself.
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (loopbackHosts.has(url.hostname)) return await realFetch(input, init);
  throw new Error(`Offline test blocked a network request to ${url.host}`);
};
