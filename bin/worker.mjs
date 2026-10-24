#!/usr/bin/env node
/** @file Internal fixed workflow phase launcher; not a release recovery or orchestration CLI. */
import path from 'node:path';
import { worker } from '../src/worker.mjs';
try { await worker(process.argv[2], path.resolve(process.argv[3] || 'app'), path.resolve(process.argv[4] || 'state')); }
catch (error) { console.error(error.message); process.exitCode = 1; }
