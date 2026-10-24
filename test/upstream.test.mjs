/** @file Verify the pinned upstream CLI exposes every supported interface, without authenticating or publishing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/io.mjs';
const cli = process.env.EXPO_RELEASE_TEST_EAS;
/** Invoke only version/help commands against the installed upstream CLI. */
function command(args) { return cli === 'eas' ? run('eas', args) : run(process.execPath, [cli, ...args]); }

test('official EAS version and public command flags match the adapter contract', { skip: !cli }, () => {
  assert.match(command(['--version']), /eas-cli\/25\.3\.0/);
  for (const [name, flags] of Object.entries({
    build: ['--json', '--freeze-credentials', '--non-interactive', '--[no-]wait'],
    'build:view': ['--json'], 'build:version:get': ['--json', '--platform'],
    submit: ['--id', '--path', '--[no-]wait', '--non-interactive'],
    update: ['--input-dir', '--skip-bundler', '--environment', '--json'],
    'env:pull': ['--path', '--environment', '--non-interactive']
  })) {
    const help = command([name, '--help']); for (const flag of flags) assert.ok(help.includes(flag), `${name} needs ${flag}`);
  }
  assert.ok(!command(['submit', '--help']).includes('--json'), 'submission acknowledgement uses the documented provider URL');
});
