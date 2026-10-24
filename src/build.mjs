/** @file Credential-free container builds and exports; command native builds receive signing inputs only. */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { assert } from './engine.mjs';
import { run, within, sourceEnvironment, seal } from './io.mjs';
import { hook } from './source.mjs';

/** Build a multi-platform OCI archive without registry authentication, then smoke-test its amd64 image. */
export async function buildServer(root, plan, directory, execute = run) {
  fs.mkdirSync(directory, { recursive: true });
  const spec = plan.config.server, archive = path.resolve(directory, 'image.tar');
  execute('docker', ['buildx', 'build', '--file', within(root, spec.dockerfile), '--platform', spec.platforms.join(','),
    '--provenance=false', '--label', `org.opencontainers.image.revision=${plan.build}`, '--label', `org.opencontainers.image.version=${plan.versions.server}`,
    '--output', `type=oci,dest=${archive}`, within(root, spec.context ?? '.')], { cwd: root, env: sourceEnvironment(), stdio: 'inherit' });
  await smoke(root, plan, archive, execute);
  return seal(directory, plan, 'server');
}

/** Run configured disposable dependencies and application assertions without deployment credentials. */
export async function smoke(root, plan, archive, execute = run, fetcher = fetch) {
  const id = `release-${randomUUID()}`, image = `${id}:smoke`, containers = [];
  const command = (args, options = {}) => execute('docker', args, { env: sourceEnvironment(), ...options });
  const spec = plan.config.server.smoke;
  try {
    execute('skopeo', ['copy', '--override-os', 'linux', '--override-arch', 'amd64', `oci-archive:${archive}`, `docker-daemon:${image}`], { env: sourceEnvironment() });
    command(['network', 'create', id]);
    for (const [name, service] of Object.entries(spec.services ?? {})) {
      const container = `${id}-${name}`; containers.push(container);
      command(['run', '-d', '--name', container, '--network', id, '--network-alias', name,
        ...Object.entries(service.environment).flatMap(([k, v]) => ['-e', `${k}=${v}`]), service.image]);
    }
    containers.push(id);
    command(['run', '-d', '--name', id, '--network', id, '-p', `127.0.0.1::${spec.port}`,
      ...Object.entries(spec.environment ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image]);
    const address = command(['port', id, String(spec.port)]).trim();
    assert(/^127\.0\.0\.1:\d+$/.test(address), 'Smoke container must bind to loopback only.');
    const baseUrl = `http://${address}`;
    let healthy = false;
    for (let attempt = 0; attempt < 45 && !healthy; attempt++) {
      try { healthy = (await fetcher(`${baseUrl}${spec.healthPath}`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* Container may still be starting. */ }
      if (!healthy) await delay(2000);
    }
    assert(healthy, 'Built server image failed its readiness check.');
    hook(root, plan.config, 'verify', { plan, target: 'server', baseUrl });
  } finally {
    for (const name of containers.reverse()) try { command(['rm', '--force', name]); } catch { /* Preserve the build failure. */ }
    try { command(['network', 'rm', id]); } catch { /* Network may not have been created. */ }
    try { command(['image', 'rm', image]); } catch { /* Archive import may have failed. */ }
  }
}

/** Compile a prepared command build using only Android signing inputs, then seal each verified bundle. */
export function commandBuild(root, plan, directory, environment = process.env) {
  const keyFile = path.resolve(directory, 'upload.keystore');
  fs.mkdirSync(directory, { recursive: true });
  const signing = { ANDROID_KEYSTORE: keyFile, ANDROID_STORE_PASSWORD: environment.ANDROID_STORE_PASSWORD,
    ANDROID_KEY_ALIAS: environment.ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD: environment.ANDROID_KEY_PASSWORD };
  assert(environment.ANDROID_KEYSTORE_BASE64 && Object.values(signing).every(Boolean), 'Missing Android signing credentials.');
  fs.writeFileSync(keyFile, Buffer.from(environment.ANDROID_KEYSTORE_BASE64, 'base64'), { mode: 0o600 });
  try {
    const command = plan.config.hooks.build;
    const env = { ...sourceEnvironment(plan.environments[plan.profile]), ...signing };
    const result = JSON.parse(run(command[0], command.slice(1), { cwd: root, env, input: JSON.stringify({ root, action: 'build', plan, directory: path.resolve(directory) }) }));
    assert(result.targets?.length === plan.config.mobile.targets.length, 'Paired build returned an incomplete artifact set.');
    for (const target of plan.config.mobile.targets) {
      const output = within(directory, target.id);
      assert(result.targets.includes(target.id), 'Builder returned a different target.');
      hook(root, plan.config, 'verify', { plan, target: target.id, directory: output }, plan.environments[plan.profile]);
      seal(output, plan, target.id);
    }
  } finally { fs.rmSync(keyFile, { force: true }); }
}
