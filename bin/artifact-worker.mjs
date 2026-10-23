#!/usr/bin/env node
/** @file Shared fixed-phase artifact worker entry point. */
import { artifactWorker } from '../src/artifact-worker.mjs';
artifactWorker(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
