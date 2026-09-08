# Data Models and Assets

Last updated: 2026-09-05

## Foundry System Template

`template.json` defines schema-like defaults for Foundry system data. It is not JSON Schema and it is not a modern Foundry DataModel class.

## Actor Model

Actor types:

- `character`
- `npc`

Actor templates:

- `stats`
- `skills`
- `info`
- `lifepath`
- `hitLocations`
- `gear`

The `character` type uses `info`, `lifepath`, `stats`, `skills`, `hitLocations`, and `gear`. The runtime currently prepares both `character` and `npc` through `_prepareCharacterData`.

Important actor data areas:

- `system.stats.*.base`
- `system.stats.*.tempMod`
- derived `system.stats.*.total`
- derived `system.stats.ref.armorMod`
- `system.hitLocations`
- derived `system.hitLocLookup`
- `system.damage`
- `system.role.value`
- `system.eurobucks`
- `system.carryWeight`
- `system.sortedSkillIDs`
- `system.skillsSortedBy`
- `system.transient.skillFilter`

## Item Model

Item types:

- `skill`
- `weapon`
- `armor`
- `cyberware`
- `vehicle`
- `misc`

Common item fields apply to all item types except `skill` according to current template metadata:

- `system.flavor`
- `system.notes`
- `system.cost`
- `system.equipped`
- `system.weight`
- `system.source`

Important type-specific areas:

| Type | Important Fields |
| --- | --- |
| `skill` | `level`, `chipLevel`, `isChipped`, `ip`, `diffMod`, `isRoleSkill`, `stat` |
| `weapon` | `weaponType`, `attackType`, `attackSkill`, `accuracy`, `damage`, `range`, `shots`, `shotsLeft`, `rof`, `reliability`, `concealability`, `availability`, `ammoType`, `rangeDamages` |
| `armor` | `coverage`, `encumbrance`, `lastOwnerId` |
| `cyberware` | `cyberwareType`, `cyberwareSubtype`, `surgCode`, `humanityCost`, `humanityLoss`, `abbrev`, `slots`, `spaces` |
| `vehicle` | `sdp`, `sp`, `speed`, `fuel`, `passengers`, `maneuverability` |
| `misc` | common fields only |

## Derived vs Persisted Data

Several values are derived during `prepareData` and should be treated carefully:

- stat totals
- REF armor modifier
- hit-location stopping power totals
- hit-location lookup map
- movement derived values
- body type modifier/carry/lift
- wound modifiers
- humanity loss/total and EMP total
- carry weight

The current code mutates `system` during preparation for derived data. Refactors should clearly separate derived values from persisted updates and avoid expanding direct mutation patterns into user edits.

## Compendium Pack Inventory

The 28 packs declared by `system.json` are LevelDB directories:

| Pack Path | Manifest Name | Document Type |
| --- | --- | --- |
| `packs/roll-tables` | `roll-tables` | `RollTable` |
| `packs/default-skills` | `default-skills` | `Item` |
| `packs/role-skills` | `role-skills` | `Item` |
| `packs/pistols` | `pistols` | `Item` |
| `packs/rifles` | `rifles` | `Item` |
| `packs/cyberware` | `cyberware` | `Item` |
| `packs/chipware` | `chipware` | `Item` |
| `packs/communication` | `communication` | `Item` |
| `packs/electronics` | `electronics` | `Item` |
| `packs/entertainment` | `entertainment` | `Item` |
| `packs/fashion` | `fashion` | `Item` |
| `packs/furnishing` | `furnishing` | `Item` |
| `packs/medical` | `medical` | `Item` |
| `packs/netrunningEquipment` | `netrunningEquipment` | `Item` |
| `packs/security` | `security` | `Item` |
| `packs/surveillance` | `surveillance` | `Item` |
| `packs/tools` | `tools` | `Item` |
| `packs/rentalandservices` | `rentalandservices` | `Item` |
| `packs/sellTheDead` | `sellthedead` | `Item` |
| `packs/armor` | `armor` | `Item` |
| `packs/vehicles` | `vehicles` | `Item` |
| `packs/melee` | `melee` | `Item` |
| `packs/smgs` | `smgs` | `Item` |
| `packs/shotguns` | `shotguns` | `Item` |
| `packs/heavyWeapons` | `heavyWeapons` | `Item` |
| `packs/bows` | `bows` | `Item` |
| `packs/exotics` | `exotics` | `Item` |
| `packs/weapons_other` | `weapons_other` | `Item` |

The tracked `packs/ammo`, `packs/gear`, and `packs/netware` directories are not
declared in `system.json`, so Foundry does not expose them. Treat them as orphaned
assets until their contents are reviewed and either declared or removed in a
separate compendium-content change.

## Localization Data

Declared languages:

- `en`, 442 keys
- `es`, 434 keys
- `it`, 473 keys

Most application strings use the `CYBERPUNK.` namespace. Settings use `SETTINGS.*` keys.

## Migration Implications

Any actor/item data shape change should be checked against:

- `template.json`
- existing document preparation code
- sheet form names
- Handlebars field paths
- compendium data
- `module/migrate.js`

Changes to skill representation, weapon fields, armor coverage, or cyberware humanity fields are especially likely to need migration logic and pack updates.
