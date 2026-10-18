#!/usr/bin/env node
/** @file Installed command entrypoint; provider credentials never enter errors or source-hook environments. */
import { main } from '../src/cli.mjs';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
