/** @file Run a retained production image with disposable declared services on a source-only runner. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { invariant } from '../packages/release-engine/index.mjs';
import { runHook, sourceEnvironment } from './hooks.mjs';

/** The configured application hook asserts responses; lifecycle, isolation and bounded readiness belong to the toolkit. */
export async function smokeImage({ plan, component, artifact, root, environment = {}, execute = execFileSync,
  fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, hook = runHook }) {
  const spec = component.smoke;
  invariant(spec && Number.isSafeInteger(spec.port) && spec.port > 0 && spec.port <= 65535
    && /^\/[A-Za-z0-9/_.-]*$/.test(spec.healthPath), 'Image smoke requires an explicit port and health path.');
  const id = `expo-smoke-${randomUUID()}`; const image = `${id}:local`; const containers = [];
  const run = (command, args) => execute(command, args, { cwd: root, env: sourceEnvironment(), windowsHide: true,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024 }).toString().trim();
  let network = false;
  const envArgs = values => Object.entries(values ?? {}).flatMap(([name, value]) => {
    invariant(/^[A-Z][A-Z0-9_]*$/.test(name) && typeof value === 'string' && !value.includes('\0'), 'Invalid smoke environment.');
    return ['--env', `${name}=${value}`];
  });
  try {
    run('skopeo', ['copy', '--override-os', 'linux', '--override-arch', 'amd64', `oci-archive:${path.join(artifact.directory, 'image.oci.tar')}`, `docker-daemon:${image}`]);
    run('docker', ['network', 'create', id]); network = true;
    for (const [name, service] of Object.entries(spec.services ?? {})) {
      invariant(/^[a-z][a-z0-9-]*$/.test(name) && typeof service.image === 'string' && service.image && !service.image.startsWith('-'), 'Invalid smoke service.');
      const container = `${id}-${name}`; containers.push(container);
      run('docker', ['run', '--detach', '--name', container, '--network', id, '--network-alias', name, ...envArgs(service.environment), service.image]);
    }
    containers.push(id);
    run('docker', ['run', '--detach', '--name', id, '--network', id, '--publish', `127.0.0.1::${spec.port}`, ...envArgs(spec.environment), image]);
    const port = run('docker', ['port', id, `${spec.port}/tcp`]);
    invariant(/^127\.0\.0\.1:\d+$/.test(port), 'Smoke port was not bound exclusively to localhost.');
    const baseUrl = `http://${port}`; const started = now(); let ready = false;
    while (now() - started < (spec.timeoutSeconds ?? 90) * 1000) {
      try { ready = (await fetcher(`${baseUrl}${spec.healthPath}`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok; } catch { /* Service startup is bounded below. */ }
      if (ready) break;
      await sleep(1000);
    }
    invariant(ready, 'Production image did not become healthy within the smoke deadline.');
    const result = hook(plan.config, 'verify', { plan, target: component.id, artifact: { ...artifact, baseUrl }, profile: plan.profile, environment }, { root });
    invariant(result.verified === true, 'Application production image assertions failed.');
    return { healthPath: spec.healthPath, verified: true };
  } finally {
    for (const name of containers.reverse()) try { run('docker', ['rm', '--force', name]); } catch { /* Disposable resource may not have started. */ }
    if (network) try { run('docker', ['network', 'rm', id]); } catch { /* Preserve the original failure. */ }
    try { run('docker', ['image', 'rm', image]); } catch { /* Import may have failed before creating the image. */ }
  }
}
