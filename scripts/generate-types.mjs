/** @file Generate the configuration declaration from the same JSON Schema used at runtime; --check detects drift. */
import fs from 'node:fs';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(fs.readFileSync(new URL('../schemas/release.config.schema.json', import.meta.url), 'utf8'));
const output = await compile(schema, 'ReleaseConfiguration', { bannerComment: '/** @file Generated from schemas/release.config.schema.json by npm run generate:types. */', style: { singleQuote: true }, unreachableDefinitions: true });
const file = new URL('../src/config.d.mts', import.meta.url);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== output) throw new Error('Configuration types changed. Run npm run generate:types.');
} else fs.writeFileSync(file, output);
