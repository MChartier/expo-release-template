/** @file Disposable image readiness keeps application assertions separate from lifecycle and always cleans its own resources. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeImage } from '../src/image-smoke.mjs';

test('source-only image smoke waits for readiness and passes only the localhost URL to the application assertion', async () => {
  const commands = []; let elapsed = 0; let reads = 0; let checked = false;
  const plan = { config: { hooks: {} }, profile: 'production' };
  const component = { id: 'server', smoke: { port: 3000, healthPath: '/ready', services: { postgres: { image: 'postgres:16-alpine' } } } };
  const result = await smokeImage({ plan, component, artifact: { directory: '/artifact' }, root: process.cwd(),
    execute: (binary, args, options) => { commands.push([binary, ...args]); assert.equal(options.env.GITHUB_TOKEN, undefined);
      return binary === 'docker' && args[0] === 'port' ? '127.0.0.1:49152\n' : ''; },
    now: () => elapsed, sleep: async ms => { elapsed += ms; }, fetcher: async url => { assert.equal(url, 'http://127.0.0.1:49152/ready'); return { ok: ++reads > 1 }; },
    hook: (_config, action, request) => { assert.equal(action, 'verify'); assert.equal(request.artifact.baseUrl, 'http://127.0.0.1:49152'); checked = true; return { verified: true }; } });
  assert.equal(result.verified, true); assert.equal(checked, true); assert.equal(reads, 2);
  assert.equal(commands.filter(value => value[0] === 'docker' && value[1] === 'rm').length, 2);
  assert(commands.some(value => value[1] === 'network' && value[2] === 'rm'));
});

test('image assertion failure still removes services and never publishes an image', async () => {
  const commands = [];
  await assert.rejects(smokeImage({ plan: { config: {} }, component: { id: 'server', smoke: { port: 3000, healthPath: '/ready' } },
    artifact: { directory: '/artifact' }, root: process.cwd(), fetcher: async () => ({ ok: true }),
    execute: (binary, args) => { commands.push([binary, ...args]); return args[0] === 'port' ? '127.0.0.1:49152' : ''; },
    hook: () => { throw new Error('application response differs'); } }), /application response differs/);
  assert(commands.some(value => value[1] === 'rm')); assert(!commands.some(value => value.includes('push')));
});
