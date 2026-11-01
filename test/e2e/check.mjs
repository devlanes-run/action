// Checks a lane that the action started, as a workflow step would use it. After `command: start`
// the workflow passes the outputs in URLS, SERVICES, HTTPS_PORT and LANE; under `command: with`
// only the lane's environment is there.

import assert from 'node:assert/strict';

const outputs = Boolean(process.env.URLS);
const urls = outputs
  ? JSON.parse(process.env.URLS ?? '{}')
  : { api: process.env.DEVLANES_PUBLIC_URL_API, worker: process.env.DEVLANES_PUBLIC_URL_WORKER };

/**
 * Fetches `url` and returns its JSON body, failing on anything but 200.
 * @param {string} url
 */
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return response.json();
}

assert.match(urls.api ?? '', /^https:\/\/api\.fixture\d*\.localhost(:\d+)?$/, 'api URL');
assert.match(urls.worker ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'worker URL without hostnames');
assert.ok(process.env.NODE_EXTRA_CA_CERTS, 'NODE_EXTRA_CA_CERTS is set for this step');
assert.ok(process.env.SSL_CERT_FILE?.endsWith('bundle.pem'), 'SSL_CERT_FILE names the bundle');
assert.ok(process.env.DEVLANES_LANE_PROJECT === 'fixture', "the lane's variables are set");

// HTTPS through the proxy, trusted through NODE_EXTRA_CA_CERTS on every OS.
assert.deepEqual(await json(`${urls.api}/healthz`), { path: '/healthz' });

if (outputs) {
  const services = JSON.parse(process.env.SERVICES ?? '{}');
  assert.equal(services.api.state, 'ready');
  assert.equal(services.worker.state, 'ready');
  assert.deepEqual(await json(`${services.api.url}/direct`), { path: '/direct' });

  // low-ports lets the Linux proxy bind 443; macOS and Windows bind it without help.
  assert.equal(process.env.HTTPS_PORT, '443', 'the proxy listens on 443');
  assert.match(process.env.LANE ?? '', /^fixture@\d+$/);
}

console.log(`ok: ${urls.api} (${outputs ? 'start' : 'with'})`);
