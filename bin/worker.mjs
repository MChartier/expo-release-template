#!/usr/bin/env node
/** @file Trusted reusable-workflow entrypoint, installed independently of the consumer's dependency tree. */
import { mainWorker } from '../src/worker.mjs';
mainWorker().catch(error => { console.error(error.message); process.exitCode = 1; });
