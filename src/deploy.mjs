/** @file Single-attempt WireGuard webhook deployment with bounded health confirmation and tunnel cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIPv4 } from 'node:net';
import { assert } from './engine.mjs';
import { run } from './io.mjs';

/** Validate the existing private deployment transport without inventing a destination. */
export function deploymentInputs(spec, env) {
  const value = Object.fromEntries(Object.entries({ host: 'DEPLOY_HOST', address: 'DEPLOY_WG_ADDRESS', endpoint: 'DEPLOY_WG_ENDPOINT',
    privateKey: 'DEPLOY_WG_PRIVATE_KEY', publicKey: 'DEPLOY_WG_PUBLIC_KEY', token: 'DEPLOY_TOKEN', url: 'DEPLOY_URL' }).map(([k, name]) => [k, env[name]]));
  assert(isIPv4(value.host ?? '') && isIPv4(value.address ?? '') && value.host !== value.address, 'Deployment requires distinct peer IPv4 addresses.');
  assert(/^[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$/.test(value.endpoint ?? '')
    && Number(value.endpoint.split(':')[1]) > 0 && Number(value.endpoint.split(':')[1]) <= 65535, 'Invalid WireGuard endpoint.');
  for (const key of ['privateKey', 'publicKey']) assert(/^[A-Za-z0-9+/]{43}=$/.test(value[key] ?? ''), 'Missing WireGuard key.');
  assert(/^[A-Za-z0-9_-]{43,128}$/.test(value.token ?? ''), 'Missing deployment token.');
  const url = new URL(value.url);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === spec.path
    && (!isIPv4(url.hostname) || url.hostname === value.host), 'Unexpected deployment URL.');
  return { ...value, url };
}

/** A healthy webhook proves service health, not the exact remotely running image digest. */
export function verifyDeploymentResponse(output, service) {
  const boundary = output.lastIndexOf('\n');
  assert(boundary >= 0 && output.slice(boundary + 1) === '200', 'Unsuccessful deployment HTTP status.');
  const body = JSON.parse(output.slice(0, boundary));
  assert(body.service === service && body.status === 'succeeded' && body.healthy === true, 'Deployment did not confirm application health.');
  return { service, healthy: true, evidence: 'webhook-health-response' };
}

/** POST once; callers retain an unresolved intent whenever acknowledgement is missing. */
export function connectAndDeploy(spec, env = process.env, execute = run) {
  const value = deploymentInputs(spec, env), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-deploy-'));
  const key = path.join(directory, 'wireguard.key'), network = 'expo-release';
  const command = (binary, args, options = {}) => execute(binary, args, { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let created = false;
  try {
    fs.chmodSync(directory, 0o700); fs.writeFileSync(key, `${value.privateKey}\n`, { mode: 0o600 });
    command('sudo', ['ip', 'link', 'add', 'dev', network, 'type', 'wireguard']); created = true;
    command('sudo', ['ip', 'address', 'add', `${value.address}/32`, 'dev', network]);
    command('sudo', ['wg', 'set', network, 'private-key', key, 'peer', value.publicKey, 'allowed-ips', `${value.host}/32`,
      'endpoint', value.endpoint, 'persistent-keepalive', '25']);
    command('sudo', ['ip', 'link', 'set', 'dev', network, 'mtu', '1420', 'up']);
    command('sudo', ['ip', 'route', 'add', `${value.host}/32`, 'dev', network]);
    const response = command('curl', ['--disable', '--silent', '--show-error', '--proto', '=https', '--noproxy', '*',
      '--request', 'POST', '--connect-timeout', '15', '--max-time', '780', '--retry', '0',
      '--resolve', `${value.url.hostname}:${value.url.port || '443'}:${value.host}`, '--config', '-', '--url', value.url.href,
      '--write-out', '\n%{http_code}'], { input: `header = "Authorization: Bearer ${value.token}"\n`, timeout: 790000 });
    return verifyDeploymentResponse(response, spec.service);
  } catch { throw new Error('Deployment failed or is uncertain. Inspect the service and resolve its GitHub deployment record before another request.'); }
  finally {
    try { if (created) command('sudo', ['ip', 'link', 'delete', network]); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
