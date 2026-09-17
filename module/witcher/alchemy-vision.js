import { SYSTEM_ID } from './config.js';
import { activeAlchemy } from './alchemy-rules.js';

/** Prepared vision only: the token's saved sight and detection settings stay intact.
 * Foundry V14 represents unlimited range as Infinity in prepared data. */
export function prepareAlchemyVision(token) {
  if (!token.sight?.enabled || !activeAlchemy(token.actor?.system, 'cat')) return false;
  const fog = token.flags?.[SYSTEM_ID]?.fogVision;
  const range = fog?.sources?.length ? Math.max(0, Number(fog.limit) || 0) : Infinity;
  token.sight.visionMode = 'darkvision';
  token.sight.range = range;
  token.detectionModes.basicSight = { ...(token.detectionModes.basicSight ?? {}), enabled: true, range };
  return true;
}

export function registerAlchemyVision() {
  const BaseToken = CONFIG.Token.documentClass;
  CONFIG.Token.documentClass = class WitcherTokenDocument extends BaseToken {
    prepareDerivedData() {
      super.prepareDerivedData();
      prepareAlchemyVision(this);
    }
  };
  Hooks.on('updateActor', (actor, changes) => {
    if (!changes.system?.effects && !changes['system.effects']) return;
    for (const token of actor.getActiveTokens?.(false, true) ?? []) {
      const document = token.document ?? token;
      document.prepareData();
      document.object?.initializeVisionSource();
    }
  });
}
