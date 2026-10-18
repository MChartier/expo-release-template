/** @file Count baseline and current consumer ownership, including relocated hooks/builders and every proposed removal; never mutate consumer files. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(process.argv[2]);
const fixture = file => new URL(`../test/fixtures/calibrate/${file}`, import.meta.url);
const original = JSON.parse(fs.readFileSync(fixture('footprint-before.json')));
const migration = JSON.parse(fs.readFileSync(fixture('migration-map.json')));
const scope = new Map(original.entries.map(value => [value.path, value.category]));
const classify = file => file.startsWith('tools/release-engine/') || file === 'tools/verify-release-engine.mjs' ? 'vendored'
  : /(?:package-lock|release-engine.lock)\.json$/.test(file) ? 'generated' : file.endsWith('.md') ? 'documentation'
  : file.startsWith('.github/workflows/') ? 'workflow' : file.includes('.test.') || file.includes('/fixtures/') ? 'test'
  : file.endsWith('.json') ? 'configuration' : 'implementation';
const extra = ['package.json', 'package-lock.json', 'mobile/eas.json', 'mobile/app.config.js', 'mobile/fingerprint.config.js', 'mobile/app.config.test.cjs',
  'scripts/native-setup.mjs', 'scripts/native-setup.test.mjs', 'scripts/native-toolchain.mjs', 'scripts/native-install.mjs', 'scripts/native-install.test.mjs',
  'scripts/native-artifact-checks.mjs', 'scripts/native-runtime-checks.mjs', 'scripts/native-upgrade-rehearsal.mjs', 'scripts/native-upgrade-rehearsal.test.mjs',
  'scripts/release-hooks.mjs', 'scripts/release-hooks.test.mjs', 'scripts/release-inputs.mjs', 'scripts/release-metadata.mjs', 'release.config.json',
  '.github/workflows/release-engine.yml', '.github/workflows/release-request.yml', '.github/workflows/release-handler.yml',
  'docs/shared-release-engine.md', 'docs/release-migration.md', 'docs/release-migration-removals.md'];
for (const file of [...migration.removedConsumerFiles, ...extra]) if (!scope.has(file)) scope.set(file, classify(file));
// Mixed-purpose files count toward net authored change, separately from dedicated release implementation/YAML.
for (const file of ['AGENTS.md', 'README.md', 'Dockerfile.app', '.dockerignore', '.gitignore', 'knip.json', 'scripts/knip-config.test.mjs',
  'deploy/README.md', 'deploy/self-hosted/README.md', 'docs/database-rollback-rehearsal.md', 'docs/physical-galaxy-validation.md', 'docs/ux-regression-gates.md',
  ...['builds', 'tests', 'lint', 'database-upgrade', 'container-scan', 'dependency-audit'].map(name => `.github/workflows/${name}.yml`)]) scope.set(file, 'supplemental');
const lines = value => value ? value.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n').length : 0;
const before = file => { try { return execFileSync('git', ['show', `${original.baseline}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); } catch { return ''; } };
const removals = new Set(migration.removedConsumerFiles);
const entries = [...scope].sort(([a], [b]) => a.localeCompare(b)).map(([file, category]) => {
  const present = fs.existsSync(path.join(root, file)); const current = present ? lines(fs.readFileSync(path.join(root, file), 'utf8')) : 0;
  return { path: file, category, before: lines(before(file)), current, afterRemoval: removals.has(file) ? 0 : current };
});
const sum = (field, categories) => entries.filter(value => categories.includes(value.category)).reduce((total, value) => total + value[field], 0);
const groups = { implementationConfigurationWorkflow: ['implementation', 'configuration', 'workflow'], releaseWorkflow: ['workflow'],
  authored: ['implementation', 'configuration', 'workflow', 'test', 'documentation', 'supplemental'], generated: ['generated'], vendored: ['vendored'] };
const totals = Object.fromEntries(Object.entries(groups).map(([name, categories]) => [name, Object.fromEntries(['before', 'current', 'afterRemoval'].map(field => [field, sum(field, categories)]))]));
const result = { schemaVersion: 1, baseline: original.baseline, method: 'Physical lines including blank/comment lines. Full dedicated release files and relocated builders/hooks/tooling remain in scope. Mixed CI/docs/root files are supplemental and count in net authored totals. Generated locks and vendored engine copies are separate; neither contributes to implementation reduction.',
  pendingRemovalCount: entries.filter(value => removals.has(value.path) && value.current).length, totals, entries };
fs.writeFileSync(fixture('footprint-current.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ pendingRemovalCount: result.pendingRemovalCount, totals }, null, 2));
