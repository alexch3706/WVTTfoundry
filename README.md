# cyberpunk2020 — for FoundryVTT

> *R. Talsorian Games' [Cyberpunk 2020](https://talsorianstore.com/products/cyberpunk-2020) for FoundryVTT. Time to get chromed, and frag some slags.*

A FoundryVTT game system package (version **2.0.0**) targeting **Foundry VTT 14 Stable 7 (build 365)** — not a standalone app. Loaded by Foundry through `system.json`, runs as ES modules in the Foundry client, renders Handlebars sheets, and ships with full item compendia.

Upgrading an existing world is irreversible without a backup. First normalize a disposable copy on the latest stable V13, take a fresh backup of that copy, and then follow the [V14 upgrade guide](./docs/v14-upgrade-guide.md) before opening it in V14.

The V14 test-release installation manifest is
[system.json for v2.0.0](https://github.com/alexch3706/cyberpunk2020foundry/releases/download/v2.0.0/system.json).
It installs a fixed release archive and does not follow the V13 `main` channel.
The GitHub prerelease label means that live-world validation is still required.

The `2.0.0` migration covers world Actors/Items, unlinked-token Actor data, and world-owned compendia (including locked packs and Adventure contents). It fails without stamping completion if a persistence operation is rejected, a pack cannot be confirmed relocked, or Foundry reports an uninitialized/invalid World or embedded document. Existing compendium IDs and paths remain unchanged.

Weapon and armor compendia now distinguish checked mechanical data from records
that require manual resolution. The item sheet explains missing fields and
unsupported rules. Use the [catalog update guide](docs/catalog-data-quality.md)
to review existing world items, preserve custom changes and inspect the remaining
content-review queue. V14 compatibility alone does not certify a catalog record's
gameplay rules.

---

## What's Here

Character sheets, compendia and automation for the supported Cyberpunk 2020 rules:

### Characters & Sheets

- **V2 Three-Pane UI Overhaul** — sleek, persistent combat panels and modernized layouts.
- **Full character sheet** — stats, skills (searchable, sortable), damage tracking, combat tab, gear inventory, cyberware, life notes.
- **NPCs** share the same data model and sheet.
- **Skills as items** — each skill is its own item with level, IP, chip level, stat association, and role-skill flag. Rollable from the sheet.
- **Armor** — per-location coverage, stopping power, encumbrance tracked per equipped piece.

### Combat Resolver

The project has a dedicated **mechanics resolver** (`module/combat/`) that produces structured, auditable combat outcomes — no more silent arithmetic.

#### Ranged Combat

| Fire Mode | Status |
|---|---|
| **Semi-auto / single shot** | ✅ Full resolution: attack roll, range DCs, modifiers, hit/miss, location, ammo |
| **Three-round burst** | ✅ Corebook burst rules: close/medium advantage, 1d3 hits, ammo |
| **Full auto — one target** | ✅ ROF, margin-based hits, damage per hit, ammo |
| **Full auto — multiple targets** | ✅ ROF division, per-target range context, rounding |
| **Suppressive fire** | ✅ Zone width, save DC (rounds÷width), Athletics+REF saves per target, failed-save hit allocation |

#### Damage Pipeline

| Mechanic | Status |
|---|---|
| **Hit locations** — random and aimed | ✅ Target-aware, uses target's own location model |
| **Armor layering** — proportional SP | ✅ Per-location, hard/soft constraints flagged |
| **Cover** | ✅ Manual cover input; scene cover deferred |
| **Armor Piercing (AP)** | ✅ Halves armor SP, then halves penetrating damage |
| **Staged penetration / ablation** | ✅ Explicit, auditable, configurable toggle (`stagedPenetration`) |
| **Body Type Modifier (BTM)** | ✅ Full BTM table, minimum damage = 1 enforcement |
| **Wound states** — Light → Mortal 9+ | ✅ Head-hit double damage, limb loss, critical injuries surfaced |
| **Stun / Death saves** | ✅ Threshold from Body Type + wound state, pending/passed/failed |
| **Reliability & jams** | ✅ Standard vs Unreliable jam outcomes, non-auto fumbles distinguished |

#### Melee & Martial Arts

| Mechanic | Status |
|---|---|
| **Opposed melee** (REF+skill+1d10 vs defender) | ✅ Case-insensitive skill matching, brawling fallback |
| **Body Type damage modifiers** | ✅ Corebook strength-damage table |
| **All martial arts styles & key technique bonuses** | ✅ 12 styles + Brawling, each with key technique data |
| **Martial actions** — strike, kick, block/parry, dodge, disarm, sweep/trip, grapple, hold, choke, throw, escape | ✅ Each produces an action-specific opposed outcome |
| **Grapple prerequisite enforcement** | ✅ Throw, hold, choke, escape check combat state before proceeding |

#### Usability

- **Preview/confirm damage** — lightweight dialog shows planned state changes (ammo, damage, armor, wounds) before commit.
- **Commit/rollback** — you can cancel and nothing persists.
- **Chat evidence** — structured chat cards show every intermediate value for referee audit.
- **Corebook Fidelity Mode** (`corebookFidelityMode` setting) — enables/disables strict rules enforcement.
- **Corebook conformance labels** — clearly distinguishes core items from extended content.
- **Staged penetration toggle** — disable for compatible/simplified play.
- **Direct commit mode** option — skip preview for speed.

### Architecture

- **Resolver layer** (`module/combat/`) — pure mechanics modules with zero Foundry runtime dependency. `CombatOutcome` is the single source of truth for chat, preview, commit, and tests.
- **State planner** — planned updates collected and validated before any Foundry document mutates.
- **Deterministic fixtures** — 8 JSON fixture files plus focused assertion modules covering combat and UI contracts, runnable outside a live world.
- **No JavaScript bundler or TypeScript.** Plain ES modules are loaded directly by Foundry; Sass compilation is the only asset build step.

### Compendia

Full item packs for: default skills, role-specific skills, weapons, armor, cyberware/chipware, gear categories, vehicles, roll tables.

### Localization

| Language | File |
|---|---|
| **English** | `lang/en.json` |
| **Spanish** | `lang/es.json` |
| **Italian** | `lang/it.json` |

---

## What's Not Yet Done

- **Netrunning** — deferred (low usage in most campaigns).
- **Mech sheet** — planned for later.
- **Scene / map cover automation** — cover is manual input only.
- **Active Effects for cyberware** — cyberware stats don't auto-modify actor stats.
- **Full Foundry ApplicationV2 / TypeDataModel rewrite** — the current ApplicationV1 sheets and `template.json` model remain supported by V14; adopting the newer architecture is a separate modernization project, not part of the V14 compatibility release.

See [`docs/`](./docs/), especially [`docs/combat-mechanics-audit.md`](./docs/combat-mechanics-audit.md), [`docs/deferred-risks-6.4.md`](./docs/deferred-risks-6.4.md), and [`docs/verification-checklist.md`](./docs/verification-checklist.md), for detailed scope tracking.

---

## Development Notes

### Stack

| Layer | What |
|---|---|
| **Runtime** | Plain JavaScript ES modules (Foundry client runtime) |
| **Entrypoint** | `module/cyberpunk2020-rilerena.js` via `system.json → esmodules` |
| **Actor** | `CyberpunkActor` (`module/actor/actor.js`) |
| **Item** | `CyberpunkItem` (`module/item/item.js`) |
| **Sheets** | Foundry `ActorSheet` / `ItemSheet` subclasses + Handlebars `.hbs` |
| **Combat resolver** | `module/combat/` — pure JS modules |
| **Styling** | Sass → `css/cyberpunk2020-rilerena.css` |
| **Data model** | `template.json` (Foundry system template) |
| **Tests** | Node.js assertion tests with JSON fixtures under `tests/combat/` |

### How to Contribute

1. Clone the repo into `Data/systems/cyberpunk2020-rilerena` (the folder name must match the manifest ID).
2. Edit `.scss` files (not `.css`) and compile:
   ```bash
   sass scss/cyberpunk2020-rilerena.scss css/cyberpunk2020-rilerena.css
   ```
   Or auto-compile on save:
   ```bash
   sass --watch scss/cyberpunk2020-rilerena.scss css/cyberpunk2020-rilerena.css
   ```
3. Run combat fixture tests:
   ```bash
   node tests/run-combat-fixtures.mjs
   ```
4. Validate the V14 manifest and every declared compendium:
   ```bash
   node tests/system-manifest.test.mjs
   node tests/pack-compatibility.test.mjs
   ```
5. Load Foundry 14.365, select the **Cyberpunk 2020 (Rilerena fork)** system, and use a disposable test world for UI and migration checks.

### Repo Layout

```
module/
  cyberpunk2020-rilerena.js # Bootstrap: init, ready, settings, helpers
  actor/                # CyberpunkActor, CyberpunkActorSheet
  item/                 # CyberpunkItem, CyberpunkItemSheet
  combat/               # Resolver: attack, armor, damage, saves, melee, martial
  dialog/               # ModifiersDialog
  dice.js               # Roll helpers (d10, Multiroll)
  lookups.js            # Constants, lookups, helper data
  settings.js           # System settings registration
  utils.js              # Shared utilities
templates/              # Handlebars templates (actor, item, chat, dialog)
scss/                   # Sass source → compiled CSS
tests/combat/           # Fixtures and assertion tests
packs/                  # LevelDB compendium directories
docs/                   # Architecture, component inventory, data models
```

### Credits

Original system by **OctarineSourceror**. Extended and refactored for core-rules combat fidelity.

All rights to *Cyberpunk 2020* lie with **R. Talsorian Games**. Compendium content contains statistical summaries equivalent to weapon/armor table rows. No copyrighted descriptive text from corebooks is included. Per [RTG's homebrew content policy](https://rtalsoriangames.com/homebrew-content-policy/).

---

*Found a bug? Want a feature? Open an issue or send a PR.*
