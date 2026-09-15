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
import { skillRoll, save } from './runtime.js';
import { registerConsequences } from './consequences.js';
import { registerCreatureAbilities } from './monster-abilities.js';
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
  game.witcher = { attack, defend, applyDamage, skillRoll, save, craft, treat, useItem, tickActor };
  await loadFoundryTemplates([
    `systems/${SYSTEM_ID}/templates/witcher/actor.hbs`,
    `systems/${SYSTEM_ID}/templates/witcher/item.hbs`,
  ]);
});
Hooks.once('ready', () => {
  registerCombatChat();
  registerActivities();
  registerConsequences();
  registerCreatureAbilities();
});
