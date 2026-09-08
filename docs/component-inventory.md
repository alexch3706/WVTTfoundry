# Component and UI Inventory

Last updated: 2026-09-05

## Runtime Components

| Component | File | Responsibility |
| --- | --- | --- |
| `CyberpunkActor` | `module/actor/actor.js` | Actor data preparation, skill/stat rolls, initiative, wound/humanity calculations |
| `CyberpunkActorSheet` | `module/actor/actor-sheet.js` | Actor sheet data context and event listeners |
| `CyberpunkItem` | `module/item/item.js` | Item behavior, weapon/combat rolls, armor morphing, vehicle acceleration |
| `CyberpunkItemSheet` | `module/item/item-sheet.js` | Item sheet data context, item type options, humanity roll, vehicle controls |
| `ModifiersDialog` | `module/dialog/modifiers.js` | FormApplication used to select attack modifiers |
| `Multiroll` | `module/dice.js` | Multi-roll chat card abstraction |

## Actor Sheet UI

| UI Area | Template | Backing logic |
| --- | --- | --- |
| Actor shell | `templates/actor/actor-sheet.hbs` | `CyberpunkActorSheet.defaultOptions`, `getData` |
| Stats row | `templates/actor/parts/statsrow.hbs` | `CyberpunkActor._prepareCharacterData`, stat roll listener |
| Wound tracker | `templates/actor/parts/woundtracker.hbs` | `damageBoxes` helper, `.damage` listener |
| Skills tab | `templates/actor/parts/skills.hbs`, `skill.hbs` | skill filtering, sorting, roll, chip toggle, level update |
| Combat tab | `templates/actor/parts/combat.hbs` | initiative, stun/death, armor display, weapon fire dialog |
| Gear tab | `templates/actor/parts/gear.hbs` | `_gearTabItems`, item edit/delete |
| Cyberware tab | `templates/actor/parts/cyberware.hbs` | cyberware cost/humanity display |
| Armor display | `templates/actor/parts/armor-display.hbs` | reused for actor hit locations and armor item coverage |

## Item Sheet UI

| Item Type | Settings Template | Summary Template | Notes |
| --- | --- | --- | --- |
| `weapon` | `templates/item/parts/weapon/settings.hbs` | `templates/item/parts/weapon/summary.hbs` | attack, damage, ammo, attack skill, market data |
| `armor` | `templates/item/parts/armor/settings.hbs` | `templates/item/parts/armor/summary.hbs` | coverage plus encumbrance |
| `cyberware` | `templates/item/parts/cyberware/settings.hbs` | `templates/item/parts/cyberware/summary.hbs` | humanity cost/loss and cyberware metadata |
| `vehicle` | `templates/item/parts/vehicle/settings.hbs` | `templates/item/parts/vehicle/summary.hbs` | speed, SDP, fuel, passengers, maneuverability |
| `skill` | `templates/item/parts/skill/settings.hbs` | `templates/item/parts/skill/summary.hbs` | level, chip level, IP, diff mod, stat, role skill |
| `misc` | `templates/item/parts/misc/settings.hbs` | `templates/item/parts/misc/summary.hbs` | common equipped/cost/weight/source fields |

## Shared Template Components

| Partial | Purpose |
| --- | --- |
| `templates/fields/string.hbs` | localized label plus text input |
| `templates/fields/number.hbs` | localized label plus number input |
| `templates/fields/boolean.hbs` | localized label plus checkbox |
| `templates/fields/select.hbs` | localized select with simple, rich, and grouped choices |

## Chat Cards

| Template | Purpose |
| --- | --- |
| `templates/chat/default-roll.hbs` | generic `Multiroll` output |
| `templates/chat/multi-hit.hbs` | full-auto and three-round burst damage tally |
| `templates/chat/weapon-roll.hbs` | currently minimal/legacy weapon card |

## Styling Components

| Sass File | Purpose |
| --- | --- |
| `scss/cyberpunk2020-rilerena.scss` | global variables, sheet shell, layout utilities, imports |
| `scss/_fields.scss` | field control look and feel |
| `scss/_statsrow.scss` | stats and derived stats |
| `scss/_woundtracker.scss` | wound state UI |
| `scss/_skills.scss` | skill list, search icon, chip icon |
| `scss/_itemSheets.scss` | item sheet header and summary |
| `scss/_gear.scss` | gear list interactions |
| `scss/_cards.scss` | chat card roll result styling |
| `scss/_combat-tab.scss` | combat tab layout and armor display |
| `scss/_weaponModifiers.scss` | weapon modifier dialog layout |
| `scss/_interactivityHints.scss` | action/inactive/not-editable hints |

## Reuse Patterns

- Templates favor shared field partials over repeated raw inputs.
- Dynamic item partial selection is based on `item.type`.
- Sheet events use CSS classes and `data-*` attributes.
- Localization is mostly centralized through `CPLocal`, `CPLocalParam`, and helper wrappers.

## UI Refactor Notes

- Keep current Handlebars partial structure unless replacing a whole sheet surface intentionally.
- The actor sheet is workable but mixes display, direct edit fields, and action triggers in tight templates.
- The item sheet has a clean dynamic partial pattern worth preserving.
- Vehicle and weapon settings templates are comparatively dense and would benefit from smaller subpartials if actively modified.
