#!/usr/bin/env node
/** @file Supporting credential setup entrypoint; release planning/execution remains on the common CLI. */
import { readConfig } from '../src/config.mjs';
import { configureLocalCredentials } from '../src/local-credentials.mjs';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--target': 'target', '--service-account-file': 'serviceAccountFile' }[process.argv[index]];
  if (!key || options[key] || !process.argv[index + 1]) throw new Error('Expected --target ID or --service-account-file ABSOLUTE_PATH.');
  options[key] = process.argv[index + 1];
}
try { process.stdout.write(`${JSON.stringify(await configureLocalCredentials({ config: readConfig(), root: process.cwd(), ...options }), null, 2)}\n`); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
