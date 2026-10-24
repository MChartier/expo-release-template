#!/usr/bin/env node
/** @file Update consumer Git pins together and let npm regenerate its lockfile; no source snapshots are copied. */
import fs from 'node:fs';
import path from 'node:path';
import { git, run, readJson, writeJson } from '../src/io.mjs';
import { assert } from '../src/engine.mjs';
const [sha, ...directories] = process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(sha ?? '') && directories.length, 'Usage: node scripts/sync-engine.mjs FULL_SHA CONSUMER...');
assert(git(process.cwd(), ['rev-parse', `${sha}^{commit}`]) === sha, 'Commit must exist before consumer pins are updated.');
for (const directory of directories) {
  const root = path.resolve(directory), file = path.join(root, 'package.json'), pkg = readJson(file);
  assert(pkg.devDependencies?.['@mchartier/expo-release'], 'Consumer must declare the toolkit as a development dependency.');
  pkg.devDependencies['@mchartier/expo-release'] = `git+https://github.com/MChartier/expo-release-template.git#${sha}`;
  writeJson(file, pkg);
  const workflow = path.join(root, '.github/workflows/release.yml');
  const source = fs.readFileSync(workflow, 'utf8');
  assert(/expo-release-template\/\.github\/workflows\/release\.yml@[a-f0-9]{40}/.test(source), 'Missing reusable release workflow pin.');
  fs.writeFileSync(workflow, source.replace(/(expo-release-template\/\.github\/workflows\/release\.yml@)[a-f0-9]{40}/g, `$1${sha}`));
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
}
