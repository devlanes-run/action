import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  failedUnits,
  httpsPort,
  infraOutputs,
  type LaneSummary,
  profileOutput,
  serviceOutputs,
  urlOutputs
} from './outputs.ts';

// Trimmed from `devlanes status --json`.
const lane: LaneSummary = {
  reference: 'acme@0',
  index: 0,
  domain: 'acme.localhost',
  units: [
    {
      name: 'api',
      state: 'ready',
      kind: 'service',
      ports: { default: 20000, inspect: 20003 },
      urls: ['http://127.0.0.1:20000', 'https://api.acme.localhost'],
      public_url: 'https://api.acme.localhost'
    },
    {
      name: 'worker',
      state: 'failed',
      kind: 'service',
      ports: { default: 20001 },
      urls: ['http://127.0.0.1:20001'],
      exit_code: 1
    },
    // Left out of the start, as a profile or `autostart: false` does.
    {
      name: 'docs',
      state: 'idle',
      kind: 'service',
      ports: { default: 20002 },
      urls: ['http://127.0.0.1:20002', 'https://docs.acme.localhost'],
      public_url: 'https://docs.acme.localhost'
    },
    { name: 'migrate', state: 'done', kind: 'task' },
    { name: 'pgadmin', state: 'external', kind: 'external', ports: { default: 5050 } }
  ],
  containers: [
    { name: 'postgres', state: 'healthy', shared: true, ports: { '5432': 20010 }, urls: [] }
  ]
};

test('services keep their ports and both URLs, without tasks', () => {
  const services = serviceOutputs(lane);
  assert.deepEqual(Object.keys(services), ['api', 'worker', 'docs', 'pgadmin']);
  assert.deepEqual(services.api, {
    state: 'ready',
    kind: 'service',
    port: 20000,
    ports: { default: 20000, inspect: 20003 },
    url: 'http://127.0.0.1:20000',
    public_url: 'https://api.acme.localhost',
    urls: ['http://127.0.0.1:20000', 'https://api.acme.localhost']
  });
  assert.equal(services.worker?.public_url, null);
});

test('urls prefer the public URL like DEVLANES_PUBLIC_URL_<SERVICE>', () => {
  const services = serviceOutputs(lane);
  assert.deepEqual(urlOutputs(services), {
    api: 'https://api.acme.localhost',
    pgadmin: 'http://127.0.0.1:5050'
  });
  // Without the failed and idle services, a loopback-only one keeps its loopback URL.
  const running = { ...services, worker: { ...services.worker!, state: 'ready' } };
  assert.equal(urlOutputs(running).worker, 'http://127.0.0.1:20001');
});

test('the profile output joins every profile of the start like the profile input', () => {
  assert.equal(profileOutput({ ...lane, profile: 'api', profiles: ['api', 'e2e'] }), 'api,e2e');
  // Daemons that send only the first one.
  assert.equal(profileOutput({ ...lane, profile: 'e2e' }), 'e2e');
  assert.equal(profileOutput({ ...lane, profile: null, profiles: [] }), '');
});

test('containers map by name', () => {
  assert.deepEqual(infraOutputs(lane), {
    postgres: { state: 'healthy', shared: true, ports: { '5432': 20010 }, urls: [] }
  });
  assert.deepEqual(infraOutputs({ reference: 'acme@0', index: 0 }), {});
});

test('the HTTPS port is reported only when the proxy is bound', () => {
  assert.equal(httpsPort({ proxy: { https: { bound: true, port: 8443 } } }), 8443);
  assert.equal(httpsPort({ proxy: { https: { bound: false, port: 443 } } }), null);
  assert.equal(httpsPort({}), null);
});

test('failed units are named', () => {
  assert.deepEqual(failedUnits(lane), ['worker']);
  assert.deepEqual(failedUnits(undefined), []);
});
