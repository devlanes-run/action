import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostsPath, laneHostnames, withBlock, withoutBlock } from './hosts.ts';

test('hostnames come from the https URLs of services and containers', () => {
  const hosts = laneHostnames({
    reference: 'acme@1',
    index: 1,
    units: [
      {
        name: 'api',
        state: 'idle',
        urls: [
          'http://127.0.0.1:20000',
          'https://api.acme1.localhost',
          'https://admin.acme1.localhost:8443',
          'https://[not a url'
        ]
      },
      { name: 'worker', state: 'idle', urls: ['http://127.0.0.1:20001'] }
    ],
    containers: [{ name: 'mailpit', urls: ['https://mail.acme1.localhost'] }]
  });
  assert.deepEqual(hosts, ['admin.acme1.localhost', 'api.acme1.localhost', 'mail.acme1.localhost']);
  assert.deepEqual(laneHostnames(undefined), []);
});

test('the hosts file is the system one on each OS', () => {
  assert.equal(hostsPath('darwin', {}), '/etc/hosts');
  assert.match(hostsPath('win32', { SystemRoot: 'C:\\Windows' }), /drivers[\\/]etc[\\/]hosts$/);
});

test('a lane block is appended once and replaced on the next write', () => {
  const original = '# Copyright (c) Microsoft\r\n127.0.0.1 localhost\r\n';
  const first = withBlock(original, 'acme@0', ['api.acme.localhost'], '\r\n');
  assert.equal(
    first,
    '# Copyright (c) Microsoft\r\n127.0.0.1 localhost\r\n# devlanes action begin acme@0\r\n127.0.0.1 api.acme.localhost\r\n# devlanes action end acme@0\r\n'
  );
  const second = withBlock(first, 'acme@0', ['web.acme.localhost'], '\r\n');
  assert.equal(second.match(/devlanes action begin/g)?.length, 1);
  assert.match(second, /127\.0\.0\.1 web\.acme\.localhost/);
  assert.doesNotMatch(second, /api\.acme\.localhost/);
});

test('two lanes keep their own blocks and removing one leaves the other', () => {
  const original = '127.0.0.1 localhost\n';
  const both = withBlock(
    withBlock(original, 'acme@0', ['api.acme.localhost'], '\n'),
    'shop@0',
    ['shop.localhost'],
    '\n'
  );
  assert.match(both, /api\.acme\.localhost/);
  assert.match(both, /shop\.localhost/);

  const shopOnly = withoutBlock(both, 'acme@0');
  assert.doesNotMatch(shopOnly, /acme/);
  assert.match(shopOnly, /shop\.localhost/);
  assert.equal(withoutBlock(shopOnly, 'shop@0'), original);
});

test('removing a block leaves the rest of the file as it was', () => {
  const original = '127.0.0.1 localhost\r\n';
  assert.equal(withoutBlock(withBlock(original, 'a@0', ['a.localhost'], '\r\n'), 'a@0'), original);
  assert.equal(withoutBlock(original, 'a@0'), original);
  assert.equal(
    withBlock('', 'a@0', ['a.localhost'], '\n'),
    '# devlanes action begin a@0\n127.0.0.1 a.localhost\n# devlanes action end a@0\n'
  );
});
