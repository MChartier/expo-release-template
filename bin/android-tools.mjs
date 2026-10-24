#!/usr/bin/env node
/** @file Install the verified Android bundle inspector before admitting signing credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const version = '1.18.3';
const expected = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const response = await fetch(`https://github.com/google/bundletool/releases/download/${version}/bundletool-all-${version}.jar`, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error('Unable to download the Android artifact inspector.');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Android artifact inspector hash differs from its reviewed pin.');
const file = path.join(process.env.RUNNER_TEMP, `bundletool-all-${version}.jar`);
fs.writeFileSync(file, bytes);
if (/[\r\n]/.test(file)) throw new Error('Unsafe tool path.');
fs.appendFileSync(process.env.GITHUB_ENV, `BUNDLETOOL_JAR=${file}\nANDROID_BUILD_TOOLS_VERSION=36.0.0\n`);
