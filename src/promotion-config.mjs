/** @file Validates declarative Play promotion cohorts, destinations and stage-specific credential names without provider access. */
import { invariant, validateId } from '../packages/release-engine/index.mjs';

/** Require every configured cohort member, unique same-app destinations, and explicit protected credentials. */
export function validatePromotions(config) {
  invariant(config.promotions === undefined || config.promotions && typeof config.promotions === 'object' && !Array.isArray(config.promotions), 'Promotions must be a named configuration object.');
  for (const [name, promotion] of Object.entries(config.promotions || {})) {
    validateId(name); invariant(name.length <= 50, 'Promotion names must leave space for stage identifiers.');
    invariant(Array.isArray(promotion.targets) && promotion.targets.length && new Set(promotion.targets).size === promotion.targets.length,
      'Promotion targets must be a nonempty unique cohort.');
    const destinations = new Set();
    invariant(promotion.tracks && Object.keys(promotion.tracks).length === promotion.targets.length, 'Promotion track inventory differs from its cohort.');
    for (const target of promotion.targets) {
      const component = config.components.find(value => value.id === target);
      invariant(component?.kind === 'native' && component.platform === 'android' && component.applicationId, 'Play promotions require configured Android applications.');
      const track = promotion.tracks[target];
      invariant(track && [track.source, track.destination].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/.test(value))
        && track.source !== track.destination, 'Promotion requires distinct exact source and destination tracks.');
      const key = `${component.applicationId}|${track.destination}`;
      invariant(!destinations.has(key), 'A promotion cannot replace the same application track twice.'); destinations.add(key);
      if (track.sourceMarkerPrefix !== undefined) invariant(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,60}$/.test(track.sourceMarkerPrefix), 'Invalid source marker prefix.');
    }
    invariant(typeof promotion.approvalEnvironment === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(promotion.approvalEnvironment), 'Promotion needs an explicit approval environment.');
    const credentials = promotion.credentials;
    invariant(credentials && Object.keys(credentials).every(key => ['accessToken', 'serviceAccountBase64'].includes(key))
      && [credentials.accessToken, credentials.serviceAccountBase64].filter(Boolean).length
      && [credentials.accessToken, credentials.serviceAccountBase64].filter(Boolean).every(value => /^GOOGLE_PLAY_[A-Z0-9_]{1,70}$/.test(value)),
    'Promotion credentials must name stage-specific Google Play secrets.');
  }
  return config;
}
