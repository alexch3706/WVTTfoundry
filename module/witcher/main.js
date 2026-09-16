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
import { skillRoll, save, errorNotice } from './runtime.js';
import { registerConsequences } from './consequences.js';
import { registerCreatureAbilities } from './monster-abilities.js';
import { registerInventory } from './inventory.js';
import { registerAuthority } from './authority.js';
import { BESTIARY_ART } from './bestiary-art.js';
import { updateBestiaryArt } from './bestiary-art-migration.js';
import { registerWoundActions, woundAction, addWound } from './wound-actions.js';
import { loadFoundryTemplates } from '../foundry-compat.js';

Hooks.once('init', async () => {
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
    updateBestiaryArt: () => updateBestiaryArt(BESTIARY_ART),
  };
  await loadFoundryTemplates([
    `systems/${SYSTEM_ID}/templates/witcher/actor.hbs`,
    `systems/${SYSTEM_ID}/templates/witcher/item.hbs`,
  ]);
});
Hooks.once('ready', async () => {
  registerInventory();
  registerCombatChat();
  registerActivities();
  registerWoundActions();
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
