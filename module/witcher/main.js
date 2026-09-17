import { registerContinuingMagicRuntime } from './magic-ongoing-runtime.js';
import { registerMagicMovement } from './magic-movement.js';
import { registerMagicRecovery } from './magic-recovery.js';
import { registerMagicRestraints } from './magic-restraints.js';
import { registerWindFog } from './magic-wind-fog.js';
import { registerHexRuntime } from './magic-hex-runtime.js';
import { registerMagicGear } from './magic-gear.js';
import {
  registerRitualRegions,
  registerRitualRuntime,
  ritualActionRestriction,
} from './magic-ritual-effects.js';
import { registerMagicLearning } from './magic-learning.js';
import { registerWorldMagicRuntime } from './magic-world-runtime.js';
import { SYSTEM_ID, ITEM_TYPES, CONDITIONS } from './config.js';
import {
  WitcherActorData,
  WitcherMonsterData,
  WitcherItemData,
  WitcherActor,
  WitcherItem,
} from './documents.js';
import { WitcherActorSheet, WitcherItemSheet } from './sheets.js';
import { attack, defend, applyDamage, registerCombatChat } from './combat.js';
import { registerActivities, craft, treat, useItem, tickActor } from './activities.js';
import { registerAlchemyCombat } from './alchemy-combat.js';
import { registerAdrenalineSetting, registerAdrenaline } from './adrenaline.js';
import { registerAlchemyRuntime } from './alchemy-runtime.js';
import { registerAlchemyEvents } from './alchemy-events.js';
import { registerAlchemyExertion } from './alchemy-exertion.js';
import { registerAlchemyVision } from './alchemy-vision.js';
import { registerEnhancements, registerEnhancementSettings } from './enhancement-runtime.js';
import { registerEnhancementCombat } from './enhancement-combat.js';
import { registerShining } from './enhancements-light.js';
import { registerSocialCommands } from './social-runtime.js';
import { registerSocialUI } from './social-ui.js';
import { skillRoll, save, errorNotice } from './runtime.js';
import { registerConsequences } from './consequences.js';
import { registerCreatureAbilities } from './monster-abilities.js';
import { registerInventory } from './inventory.js';
import { registerAuthority } from './authority.js';
import { BESTIARY_ART } from './bestiary-art.js';
import { updateBestiaryArt } from './bestiary-art-migration.js';
import { registerWoundActions, woundAction, addWound } from './wound-actions.js';
import { registerMagicCommands, promptMagicCollapse, refreshMagicCard } from './magic-runtime.js';
import { registerMagicZones } from './magic-zones.js';
import { registerMagicLifecycle } from './magic-lifecycle.js';
import { registerMagicChat, castMagic, defendMagic, counterMagic } from './magic-ui.js';
import { loadFoundryTemplates } from '../foundry-compat.js';

Hooks.once('init', async () => {
  registerAdrenalineSetting();
  registerEnhancementSettings();
  registerAlchemyVision();
  CONFIG.Actor.documentClass = WitcherActor;
  CONFIG.Item.documentClass = WitcherItem;
  CONFIG.Actor.dataModels = {
    character: WitcherActorData,
    npc: WitcherActorData,
    monster: WitcherMonsterData,
  };
  CONFIG.Item.dataModels = Object.fromEntries(ITEM_TYPES.map((type) => [type, WitcherItemData]));
  CONFIG.Combat.initiative = { formula: '1d10 + @derived.stats.ref', decimals: 2 };
  CONFIG.time.roundTime = 3;
  registerMagicZones();
  registerRitualRegions();
  registerMagicLifecycle({ onCollapse: promptMagicCollapse });
  Hooks.on('preCreateScene', (scene, data) => {
    if (!data.grid?.units && !data.grid?.distance)
      scene.updateSource({ 'grid.distance': 2, 'grid.units': 'm' });
  });
  CONFIG.statusEffects = Object.entries(CONDITIONS).map(([id, name]) => ({
    id,
    name,
    img: `icons/svg/${id === 'dead' ? 'skull' : id === 'fire' ? 'fire' : id === 'bleeding' ? 'blood' : id === 'poison' ? 'poison' : id === 'prone' ? 'falling' : id === 'stunned' ? 'daze' : 'aura'}.svg`,
  }));
  foundry.documents.collections.Actors.registerSheet(SYSTEM_ID, WitcherActorSheet, {
    types: ['character', 'npc', 'monster'],
    makeDefault: true,
    label: 'Witcher character / NPC',
  });
  foundry.documents.collections.Items.registerSheet(SYSTEM_ID, WitcherItemSheet, {
    types: ITEM_TYPES,
    makeDefault: true,
    label: 'Witcher equipment',
  });
  game.witcher = {
    attack,
    defend,
    applyDamage,
    skillRoll,
    save,
    craft,
    treat,
    useItem,
    tickActor,
    woundAction,
    addWound,
    castMagic,
    defendMagic,
    counterMagic,
    updateBestiaryArt: () => updateBestiaryArt(BESTIARY_ART),
  };
  await loadFoundryTemplates([
    `systems/${SYSTEM_ID}/templates/witcher/actor.hbs`,
    `systems/${SYSTEM_ID}/templates/witcher/item.hbs`,
    `systems/${SYSTEM_ID}/templates/witcher/magic.hbs`,
    `systems/${SYSTEM_ID}/templates/witcher/magic-item.hbs`,
  ]);
});
Hooks.once('ready', async () => {
  registerInventory();
  registerCombatChat();
  registerActivities();
  registerAlchemyCombat();
  registerAdrenaline();
  registerAlchemyRuntime();
  registerAlchemyEvents();
  registerAlchemyExertion();
  registerEnhancements();
  registerEnhancementCombat();
  registerShining();
  registerSocialCommands();
  registerSocialUI();
  registerWoundActions();
  registerMagicCommands();
  registerWorldMagicRuntime({ refreshCard: refreshMagicCard });
  registerMagicChat();
  registerMagicLearning();
  registerHexRuntime();
  registerContinuingMagicRuntime();
  registerMagicMovement();
  registerMagicRecovery();
  registerMagicRestraints();
  registerWindFog();
  await registerRitualRuntime();
  registerMagicGear();
  Hooks.on('preUpdateToken', (token, changes, options = {}) => {
    if (!token.actor || !['x', 'y', 'elevation'].some((key) => Object.hasOwn(changes, key))) return;
    const healingRest = token.actor.system.effects.some(
      (effect) => effect.magic?.healingRest && !effect.disabled && !effect.magic.suppressed
    );
    if (healingRest && !game.user.isGM && !options.witcherForcedMovement && !options.witcherMagicRollback) {
      ui.notifications.warn(
        'Healing Rest prevents voluntary movement. The GM can move a carried or displaced body.'
      );
      return false;
    }
    const reason = ritualActionRestriction(token.actor, 'move');
    if (reason) {
      ui.notifications.warn(reason);
      return false;
    }
  });
  registerConsequences();
  registerCreatureAbilities();
  registerAuthority();
  Hooks.on('updateCombat', () => {
    const actors = new Map(
      [...game.actors, ...(canvas.tokens?.placeables ?? []).map((t) => t.actor).filter(Boolean)].map((a) => [
        a.uuid,
        a,
      ])
    );
    for (const actor of actors.values()) if (actor.sheet?.rendered) actor.sheet.render(false);
  });
  try {
    const result = await game.witcher.updateBestiaryArt();
    if (result.errors.length) {
      console.warn(`${SYSTEM_ID} | Bestiary art update`, result);
      ui.notifications.warn(
        'Some bestiary images could not be updated. The GM can retry with game.witcher.updateBestiaryArt(). Details are in the console.'
      );
    }
  } catch (error) {
    errorNotice(error);
  }
});
