/** @file Single-attempt WireGuard webhook transport; affirmative health is never proof of an exact deployed image digest. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIPv4 } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { invariant } from '../../packages/release-engine/index.mjs';

/** Validate the existing private transport without inventing a deployment target or credential. */
export function deploymentInputs(spec, environment) {
  const value = { ...spec, ...Object.fromEntries(Object.entries(spec.variables ?? {}).map(([key, name]) => [key, environment[name]])) };
  invariant(isIPv4(value.host ?? '') && isIPv4(value.address ?? '') && value.host !== value.address, 'Deployment requires distinct server and CI peer IPv4 addresses.');
  invariant(/^[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$/.test(value.endpoint ?? ''), 'Invalid WireGuard endpoint.');
  const port = Number(value.endpoint.split(':')[1]);
  invariant(port > 0 && port <= 65535, 'Invalid WireGuard endpoint port.');
  for (const key of ['privateKey', 'publicKey']) invariant(/^[A-Za-z0-9+/]{43}=$/.test(value[key] ?? ''), 'Missing WireGuard key.');
  invariant(/^[A-Za-z0-9_-]{43,128}$/.test(value.token ?? ''), 'Missing deployment token.');
  const url = new URL(value.url);
  invariant(url.protocol === 'https:' && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === spec.path
    && (!isIPv4(url.hostname) || url.hostname === value.host), 'Deployment URL differs from its configured HTTPS endpoint.');
  invariant(typeof spec.service === 'string' && spec.service && Number.isSafeInteger(spec.timeoutSeconds ?? 780)
    && (spec.timeoutSeconds ?? 780) > 0 && (spec.timeoutSeconds ?? 780) <= 1800, 'Invalid deployment service or timeout.');
  return { ...value, url };
}

/** Require the configured service's affirmative health response without retaining credential-bearing diagnostics. */
export function verifyDeploymentResponse(output, spec) {
  const boundary = output.lastIndexOf('\n');
  invariant(boundary >= 0 && output.slice(boundary + 1) === '200', 'Unsuccessful webhook HTTP status.');
  const body = JSON.parse(output.slice(0, boundary));
  invariant(body?.service === spec.service && body.status === 'succeeded' && body.healthy === true, 'Deployment webhook did not confirm application health.');
  return { service: spec.service, healthy: true, evidence: 'webhook-health-response' };
}

/** POST once and always remove the temporary runner tunnel/key; ambiguous outcomes remain the executor's responsibility. */
export function connectAndDeploy(spec, environment = process.env, run = execFileSync) {
  const value = deploymentInputs(spec, environment);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-deploy-'));
  const key = path.join(directory, 'wireguard.key');
  const network = 'expo-release';
  const command = (binary, args, options = {}) => run(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000, ...options });
  let created = false;
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(key, `${value.privateKey}\n`, { mode: 0o600 });
    command('sudo', ['ip', 'link', 'add', 'dev', network, 'type', 'wireguard']);
    created = true;
    command('sudo', ['ip', 'address', 'add', `${value.address}/32`, 'dev', network]);
    command('sudo', ['wg', 'set', network, 'private-key', key, 'peer', value.publicKey,
      'allowed-ips', `${value.host}/32`, 'endpoint', value.endpoint, 'persistent-keepalive', '25']);
    command('sudo', ['ip', 'link', 'set', 'dev', network, 'mtu', '1420', 'up']);
    command('sudo', ['ip', 'route', 'add', `${value.host}/32`, 'dev', network]);
    const timeout = spec.timeoutSeconds ?? 780;
    const response = command('curl', ['--disable', '--silent', '--show-error', '--proto', '=https', '--noproxy', '*',
      '--request', 'POST', '--connect-timeout', '15', '--max-time', String(timeout), '--retry', '0',
      '--resolve', `${value.url.hostname}:${value.url.port || '443'}:${value.host}`, '--config', '-', '--url', value.url.href,
      '--write-out', '\n%{http_code}'], { input: `header = "Authorization: Bearer ${value.token}"\n`, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: (timeout + 10) * 1000, maxBuffer: 64 * 1024 });
    return verifyDeploymentResponse(response, spec);
  } catch { throw new Error('Deployment failed or health was not confirmed. Inspect the service logs before reconciliation; a timed-out request may still be deploying.'); }
  finally {
    try { if (created) command('sudo', ['ip', 'link', 'delete', network]); }
    catch { throw new Error('Deployment tunnel cleanup failed. The temporary key was removed; inspect the disposable runner before another request.'); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}

/** Provide transport observations without retry, journal mutation, or treating a search miss as absence. */
export function createDeploymentProvider(spec, { environment = process.env, run, transport = connectAndDeploy } = {}) {
  const observations = new Map();
  return {
    async start() {
      const receipt = transport(spec, environment, run);
      const id = randomUUID();
      observations.set(id, { id, status: 'complete', receipt });
      return { id };
    },
    async find() { return null; },
    async verifyAbsence(evidence, context) { return verifyDeploymentReconciliation(evidence, spec, context, 'not-started'); },
    async reconcile(evidence, context) { return verifyDeploymentReconciliation(evidence, spec, context, 'healthy'); },
    async status(id) { return observations.get(id) ?? { id, status: 'unknown' }; },
    async verify(observed) {
      invariant(observed.status === 'complete' && observed.receipt?.healthy === true && observed.receipt.service === spec.service,
        'Deployment requires fresh health evidence or explicit operator reconciliation.');
      return observed.receipt;
    }
  };
}

/** Preserve explicit operator recovery for a webhook without a query API; this evidence never asserts an image digest. */
export function verifyDeploymentReconciliation(value, spec, context, outcome) {
  invariant(value?.confirmed === true && value.outcome === outcome && value.service === spec.service
    && value.planDigest === context.planDigest && value.operationKey === context.operationKey && value.attempt === context.attempt
    && typeof value.evidence === 'string' && value.evidence.trim().length >= 20 && value.evidence.length <= 2000
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
    && (!value.evidenceKind || value.evidenceKind === 'operator-service-log-reconciliation')
    && Object.keys(value).every(key => ['confirmed', 'outcome', 'service', 'planDigest', 'operationKey', 'attempt', 'evidence', 'observedAt', 'body', 'evidenceKind'].includes(key)),
  'Deployment reconciliation requires explicit operator service-log evidence bound to this exact request attempt.');
  if (outcome === 'healthy') verifyDeploymentResponse(`${JSON.stringify(value.body)}\n200`, spec);
  else invariant(!value.body, 'Absence cannot also claim a successful deployment.');
  return { ...value, evidenceKind: 'operator-service-log-reconciliation', ...(outcome === 'healthy' ? { healthy: true } : {}) };
}
