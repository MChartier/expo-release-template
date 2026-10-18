/** @file Run application source hooks through one bounded JSON protocol without publication credentials. */
import { execFileSync } from 'node:child_process';
import { invariant } from '../packages/release-engine/index.mjs';

/** Keep source tools operational while removing authentication and workflow command-file capabilities. */
export function sourceEnvironment(environment = process.env, publicEnvironment = {}) {
  const portable = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL|CI|TERM|NO_COLOR|FORCE_COLOR|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|GRADLE_USER_HOME|BUNDLETOOL_JAR|ANDROID_BUILD_TOOLS_VERSION)$/i;
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => portable.test(key)));
  for (const [key, value] of Object.entries(publicEnvironment)) {
    invariant(/^[A-Z][A-Z0-9_]*$/.test(key) && (key === 'NODE_ENV' || !/^(NODE_|NPM_|GIT_|GITHUB_|ACTIONS_|LD_|DYLD_|BASH_|ENV$|EXPO_TOKEN$)/.test(key)), 'Unsafe source environment variable.');
    invariant(typeof value === 'string', 'Source environment values must be strings.');
    result[key] = value;
  }
  return result;
}

/** Invoke a configured source-only hook. Its returned metadata is evidence to verify, never authorization. */
export function runHook(config, action, input = {}, { root = process.cwd(), environment = process.env, execute = execFileSync } = {}) {
  const hook = config.hooks?.[action];
  invariant(hook, `No application ${action} hook is configured.`);
  const [command, ...args] = hook.command;
  const executable = command === 'node' ? process.execPath : command;
  const output = execute(executable, args, { cwd: root, windowsHide: true,
    input: JSON.stringify({ ...input, schemaVersion: 1, action, root, config }), encoding: 'utf8',
    env: sourceEnvironment(environment, input.environment ?? {}), stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024,
    timeout: hook.timeoutMs ?? 1800000 });
  const result = JSON.parse(output);
  invariant(result?.schemaVersion === 1, `Application ${action} hook returned an unsupported schema.`);
  return result;
}
