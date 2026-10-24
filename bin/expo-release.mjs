#!/usr/bin/env node
/** @file Read-only configuration validation and release preview; execution lives in GitHub Actions. */
import { parseArgs } from 'node:util';
import { loadConfig, configured } from '../src/config.mjs';
import { selectRelease } from '../src/engine.mjs';
import { inspect } from '../src/source.mjs';
import { github, loadHistory } from '../src/github.mjs';
import { readJson, run } from '../src/io.mjs';
import { readEnvironments } from '../src/eas.mjs';
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string' }, history: { type: 'string' }, rebuild: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) console.log('expo-release validate | plan --profile NAME [--rebuild] [--history CONTEXT.json]\nReleases run through the protected GitHub workflow.');
  else {
    const root = process.cwd(), config = loadConfig(root);
    if (positionals[0] === 'validate') console.log('Release configuration is valid.');
    else if (positionals[0] === 'plan') {
      const offline = values.history && readJson(values.history);
      const history = offline?.history ?? await loadHistory(github(config.repository, {
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run('gh', ['auth', 'token']).trim(),
      }));
      const environments = offline?.environments ?? readEnvironments(config);
      console.log(JSON.stringify(selectRelease(configured(config), values.profile, inspect(root, config, undefined, environments), history, values.rebuild), null, 2));
    } else throw new Error('Only validate and plan are supported; use GitHub/EAS tools for release operations.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
