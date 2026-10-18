/** @file External local signing settings and atomic EAS credential refresh; secret contents never enter consumer state or source installation. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { invariant } from '../packages/release-engine/index.mjs';
import { sourceEnvironment } from './hooks.mjs';
import { resolveExpoConfiguration } from './environment.mjs';
import { createEasTransport, downloadEasAndroidCredentials } from './providers/eas.mjs';
import { createGoogleServiceAccountAssertion } from './providers/play-transport.mjs';

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Resolve an existing external credential without allowing repository paths or symlink aliases into the checkout. */
export function externalCredential(root, file) {
  invariant(typeof file === 'string' && path.isAbsolute(file), 'Credential files must use absolute external paths.');
  const resolved = fs.realpathSync(file);
  invariant(fs.statSync(resolved).isFile() && !contained(fs.realpathSync(root), resolved), 'Credential files must remain outside the checkout.');
  return resolved;
}

/** Preserve configured user settings locations while keeping future applications isolated by repository identity. */
export function localSettingsPath(config, root, environment = process.env, platform = process.platform) {
  const base = platform === 'win32' ? environment.LOCALAPPDATA : environment.XDG_CONFIG_HOME || path.join(environment.HOME || os.homedir(), '.config');
  const namespace = config.local?.settingsDirectory ?? config.repository.replace('/', '-');
  const name = config.local?.settingsFile ?? 'expo-release.json';
  invariant(base && path.isAbsolute(base) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespace)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name), 'Invalid external settings location.');
  const destination = path.join(base, namespace, name);
  let existing = path.dirname(destination); const suffix = [name];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  const resolved = path.join(fs.realpathSync(existing), ...suffix);
  invariant(!contained(fs.realpathSync(root), resolved), 'Local settings must remain outside the checkout.');
  return resolved;
}

/** Read path-only settings and declared legacy metadata without opening keys or adopting a historical local cache as release evidence. */
export function readLocalSettings({ config, root, target, environment, platform }) {
  const file = localSettingsPath(config, root, environment, platform);
  if (!fs.existsSync(file)) return { file, settings: { schemaVersion: 1 }, credentials: {} };
  let settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacyField = config.local?.legacyCredentialsField;
  if (legacyField && settings?.schemaVersion === undefined) {
    const metadata = config.local?.legacyMetadataFields ?? {};
    invariant(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(legacyField) && target && settings && !Array.isArray(settings)
      && Object.entries(metadata).every(([key, type]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
        && key !== legacyField && ['path', 'string-map'].includes(type))
      && Object.keys(settings).every(key => key === legacyField || Object.hasOwn(metadata, key))
      && (!Object.hasOwn(settings, legacyField) || typeof settings[legacyField] === 'string' && path.isAbsolute(settings[legacyField])), 'Unsupported legacy credential settings.');
    for (const [key, type] of Object.entries(metadata)) if (Object.hasOwn(settings, key)) {
      const value = settings[key];
      invariant(type === 'path' ? typeof value === 'string' && path.isAbsolute(value)
        : value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string'), 'Unsupported legacy metadata settings.');
    }
    settings = { schemaVersion: 1, targets: { [target]: settings[legacyField] ? { credentialsFile: settings[legacyField] } : {} }, legacy: settings };
  }
  invariant(settings.schemaVersion === 1 && Object.keys(settings).every(key => ['schemaVersion', 'targets', 'credentialsFile', 'serviceAccountFile', 'legacy'].includes(key)), 'Unsupported local settings.');
  const credentials = settings.targets?.[target] ?? settings;
  for (const key of ['credentialsFile', 'serviceAccountFile']) if (credentials[key]) invariant(path.isAbsolute(credentials[key]), 'Saved credentials must be absolute paths.');
  return { file, settings, credentials };
}

/** Atomically replace one target's external paths while preserving other targets and original settings evidence. */
export function saveLocalCredentialPaths({ config, root, target, credentialsFile, serviceAccountFile, environment, platform }) {
  invariant(typeof target === 'string' && config.components.some(value => value.id === target && value.kind === 'native'), 'Choose a configured native credential target.');
  const previous = readLocalSettings({ config, root, target, environment, platform });
  const credentials = { credentialsFile: externalCredential(root, credentialsFile),
    ...(serviceAccountFile ? { serviceAccountFile: externalCredential(root, serviceAccountFile) } : {}) };
  const settings = { schemaVersion: 1, ...(previous.settings.legacy ? { legacy: previous.settings.legacy } : {}),
    targets: { ...previous.settings.targets, [target]: credentials } };
  fs.mkdirSync(path.dirname(previous.file), { recursive: true, mode: 0o700 });
  const temporary = `${previous.file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, previous.file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return { file: previous.file, settings, credentials };
}

/** Read signing contents only after credential-free prebuild has succeeded. */
export function localSigningInputs({ config, root, target, credentialsFile, environment, platform }) {
  const configured = credentialsFile ?? readLocalSettings({ config, root, target, environment, platform }).credentials.credentialsFile;
  invariant(configured, 'Configure Android credentials with npm run native:configure before a local build.');
  const signing = JSON.parse(fs.readFileSync(externalCredential(root, configured), 'utf8')).android?.keystore;
  invariant(['keystorePath', 'keystorePassword', 'keyAlias', 'keyPassword'].every(key => typeof signing?.[key] === 'string' && signing[key]), 'Incomplete external Android signing credential.');
  return { ANDROID_KEYSTORE_BASE64: fs.readFileSync(externalCredential(root, signing.keystorePath)).toString('base64'),
    ANDROID_STORE_PASSWORD: signing.keystorePassword, ANDROID_KEY_ALIAS: signing.keyAlias, ANDROID_KEY_PASSWORD: signing.keyPassword };
}

/** Download exact assigned credentials into a fresh external workspace and replace saved paths only after all validation passes. */
export async function configureLocalCredentials({ config, root, target, serviceAccountFile, environment = process.env, platform = process.platform,
  transportFactory = createEasTransport, log = text => process.stderr.write(`${text}\n`) }) {
  const candidates = config.components.filter(value => value.kind === 'native' && value.platform === 'android' && value.signing);
  const component = target ? candidates.find(value => value.id === target) : candidates.length === 1 ? candidates[0] : null;
  invariant(component, 'Select one configured command Android signing target with --target.');
  const expo = resolveExpoConfiguration(config, root); const spec = { ...expo, applicationId: component.applicationId };
  const previous = readLocalSettings({ config, root, target: component.id, environment, platform });
  const parent = path.dirname(previous.file); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(parent, 'eas-android-')); fs.chmodSync(directory, 0o700);
  let committed = false;
  try {
    fs.writeFileSync(path.join(directory, 'app.json'), JSON.stringify({ expo: { name: expo.slug, slug: expo.slug, owner: expo.owner,
      android: { package: component.applicationId }, extra: { eas: { projectId: expo.projectId } } } }));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'release-credentials', version: '1.0.0', private: true }));
    fs.writeFileSync(path.join(directory, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'local' }, build: { credentials: { credentialsSource: 'remote', distribution: 'internal' } } }));
    const providerEnvironment = { ...sourceEnvironment(environment), EAS_NO_VCS: '1', EAS_PROJECT_ROOT: directory, EXPO_NO_DOTENV: '1',
      ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}) };
    const transport = transportFactory({ cwd: directory, env: providerEnvironment });
    log(`Configure signing for @${expo.owner}/${expo.slug} / ${component.applicationId}.`);
    await transport.cli(['credentials:configure-build', '--platform', 'android', '--profile', 'credentials'], false, { interactive: true });
    await transport.project(expo);
    const credentialsFile = await downloadEasAndroidCredentials(spec, directory, transport);
    let playFile;
    const account = serviceAccountFile ? JSON.parse(fs.readFileSync(externalCredential(root, serviceAccountFile), 'utf8')) : await transport.assignedPlayCredentials(spec);
    if (account) {
      createGoogleServiceAccountAssertion(account);
      playFile = serviceAccountFile ? externalCredential(root, serviceAccountFile) : path.join(directory, 'play-service-account.json');
      if (!serviceAccountFile) fs.writeFileSync(playFile, `${JSON.stringify(account)}\n`, { flag: 'wx', mode: 0o600 });
    } else log('No Play key is assigned to this app. Build/install remain available; assign a key in EAS before local submission.');
    localSigningInputs({ config, root, target: component.id, credentialsFile, environment, platform });
    saveLocalCredentialPaths({ config, root, target: component.id, credentialsFile, serviceAccountFile: playFile, environment, platform });
    committed = true;
    return { file: previous.file, target: component.id, credentialsFile, ...(playFile ? { serviceAccountFile: playFile } : {}) };
  } catch {
    throw new Error('Credential refresh failed. Check the exact EAS project, default Android key and assigned Play key. Previous settings are unchanged.');
  } finally {
    if (!committed) {
      invariant(path.dirname(fs.realpathSync(directory)) === fs.realpathSync(parent), 'Credential workspace escaped its external parent.');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
