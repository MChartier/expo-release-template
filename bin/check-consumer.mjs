#!/usr/bin/env node
/** @file Read-only consumer configuration and immutable package/workflow pin verification. */
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { verifyToolkitPins } from '../src/source.mjs';
const root = path.resolve(process.env.RELEASE_CONSUMER_PATH ?? '.');
readConfig(root);
const revision = verifyToolkitPins(root, { expectedRevision: process.env.RELEASE_TOOLKIT_REVISION });
process.stdout.write(`Release configuration and package/workflow pins verified at ${revision}.\n`);
