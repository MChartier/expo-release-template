/** @file Stamp the example's only metadata file; release orchestration remains in the shared workflow. */
import fs from 'node:fs';
const { plan } = JSON.parse(fs.readFileSync(0, 'utf8'));
const app = JSON.parse(fs.readFileSync('app.json'));
app.expo.version = plan.versions.mobile;
fs.writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
console.log('{}');
