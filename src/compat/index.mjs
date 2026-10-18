/** @file Historical format dispatch is isolated from all new release execution. */
import { calibrateReader } from './calibrate.mjs';
import { littleSayLegacyReader } from './little-say.mjs';
export const legacyReaders = Object.freeze([calibrateReader, littleSayLegacyReader]);
