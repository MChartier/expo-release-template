/** @file Disposable smoke environments are isolated and cleaned after success or failure; no Docker daemon is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from '../src/build.mjs';
import { plan, temporary } from './helpers.mjs';

/** Capture container commands with one disposable database and a healthy loopback response. */
function harness(t) {
  const root = temporary(t), release = plan(), calls = [];
  release.config.server.smoke.services = { database: { image: 'postgres:16-alpine', environment: { POSTGRES_PASSWORD: 'disposable' } } };
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    return args[0] === 'port' ? '127.0.0.1:43210' : '';
  };
  return { root, release, calls, execute };
}

test('smoke uses the exact archive, isolated networking, loopback binding and credential-free commands', async t => {
  const h = harness(t), previous = process.env.EXPO_TOKEN;
  process.env.EXPO_TOKEN = 'publication-secret';
  t.after(() => previous === undefined ? delete process.env.EXPO_TOKEN : process.env.EXPO_TOKEN = previous);
  await smoke(h.root, h.release, 'exact-image.tar', h.execute, async url => {
    assert.equal(url, 'http://127.0.0.1:43210/health'); return { ok: true };
  });
  assert.ok(h.calls[0].args.includes('oci-archive:exact-image.tar'));
  assert.ok(h.calls.every(call => !call.options.env.EXPO_TOKEN));
  const containers = h.calls.filter(call => call.args[0] === 'run');
  assert.equal(containers.length, 2);
  assert.ok(containers[1].args.includes('127.0.0.1::8080'));
  assert.ok(containers.every(call => call.args.includes('--network')));
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, 2);
  assert.deepEqual(h.calls.at(-2).args.slice(0, 2), ['network', 'rm']);
  assert.deepEqual(h.calls.at(-1).args.slice(0, 2), ['image', 'rm']);
});

test('a failed dependency start removes attempted containers, the network and imported image', async t => {
  const h = harness(t);
  await assert.rejects(smoke(h.root, h.release, 'image.tar', (...args) => {
    const output = h.execute(...args);
    if (args[1][0] === 'run') throw new Error('dependency did not start');
    return output;
  }), /dependency did not start/);
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, 1);
  assert.deepEqual(h.calls.at(-1).args.slice(0, 2), ['image', 'rm']);
});

test('an unexpected public binding fails before the health request and still cleans up', async t => {
  const h = harness(t); let fetched = false;
  await assert.rejects(smoke(h.root, h.release, 'image.tar', (...args) => {
    h.execute(...args); return args[1][0] === 'port' ? '0.0.0.0:43210' : '';
  }, async () => { fetched = true; return { ok: true }; }), /loopback/);
  assert.equal(fetched, false);
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, 2);
});

test('cleanup errors preserve the original container failure', async t => {
  const h = harness(t);
  await assert.rejects(smoke(h.root, h.release, 'image.tar', (...args) => {
    h.execute(...args);
    if (args[1][0] === 'run') throw new Error('original failure');
    if (args[1].includes('rm')) throw new Error('cleanup failure');
    return '';
  }), /original failure/);
  assert.deepEqual(h.calls.at(-1).args.slice(0, 2), ['image', 'rm']);
});
