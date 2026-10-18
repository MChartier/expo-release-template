#!/usr/bin/env node
/** @file Provision the reviewed Android binary inspector before signing credentials are admitted. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const version = '1.18.3';
const expected = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const response = await fetch(`https://github.com/google/bundletool/releases/download/${version}/bundletool-all-${version}.jar`, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error('Unable to download the pinned Android artifact inspector.');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Android artifact inspector hash differs from the reviewed pin.');
const destination = path.join(process.env.RUNNER_TEMP, `bundletool-all-${version}.jar`);
fs.writeFileSync(destination, bytes);
if (/[\r\n]/.test(destination)) throw new Error('Unsafe Android artifact inspector path.');
fs.appendFileSync(process.env.GITHUB_ENV, `BUNDLETOOL_JAR=${destination}\nANDROID_BUILD_TOOLS_VERSION=36.0.0\n`);
