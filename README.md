# The Witcher TTRPG — Foundry V14

Independent Witcher implementation based on the owner's Cyberpunk V14 history
and the supplied **Core Rulebook v1.35**, **A Tome of Chaos v1.01**, and equipment supplements. System ID: `witcher-rilerena`.

**Installable alpha with ordinary combat, critical wounds and an initial magic implementation. Live Forge acceptance is pending.**
No runtime code from another Witcher system is included. Two general Foundry
compatibility helpers are retained from Cyberpunk.

## Current contents

- Character, NPC and monster data models and sheets.
- Attack, defense and GM damage workflow, location armor, wounds, saves,
  resources, crafting and equipment.
- Optional manual d10 entry for attacks and defenses, with complete exploding
  and fumbling chains, automatic modifiers and a visible manual-entry label.
- **809 equipment, component, mutagen and recipe records** in ten Item compendia: 673 core + 46 A Witcher’s Tools + 90 A Witcher’s Journal.
- **24 critical injury Items** in **Critical Wounds**: drag onto an actor,
  apply stage-specific penalties, stabilize/treat and track recovery. Healed
  cards preserve history and permanent consequences. See the
  [critical wound guide](docs/witcher/critical-wounds.md).
- **36 creatures and NPCs** in **Core Bestiary & NPCs**, including printed
  variants, animals and three named adventure NPCs; **253 embedded records**.
- Portraits and round map tokens for all **36 entries**: 28 use book art and
  8 use generated originals. Existing imported placeholders update on GM startup;
  custom images are preserved. See [art sources and preview](docs/witcher/art-sources.md).

- **238 magic references** across five compendiums, plus **45 magical artifact/material records**. Casting is enabled for **12 Signs, 34 spells and 20 invocations**; other spell/invocation records are clearly marked as references. Rituals and hexes use separate workflows. See the [magic player guide](docs/witcher/magic-play-guide.md) and [support matrix](docs/witcher/magic-progress.md).

See [implementation status](docs/witcher/implementation-status.md) for remaining
work and [bestiary coverage](docs/witcher/bestiary.md) for adaptations and limits.
Magic coverage and remaining work are listed in the [magic support matrix](docs/witcher/magic-progress.md). Mounted combat and broader active creature/profession abilities remain outside the current priority.

## Install on The Forge

Use the [v0.1.0-alpha.6 manifest](https://github.com/alexch3706/WVTTfoundry/releases/download/v0.1.0-alpha.6/system.json) in **Install from Manifest**.
See [installation instructions](docs/witcher/install.md) and [release assets](https://github.com/alexch3706/WVTTfoundry/releases/tag/v0.1.0-alpha.6).
Create a new Witcher world; use a 2 m grid and an active GM for combat commands.

## Validation

```sh
npm ci
npm test
npm run build:wounds
npm run build:magic
npm run build:packs
npm run validate
```

The official Foundry CLI builds real LevelDB packs, reads them back and compares
every document, including embedded items. An optional check uses an externally
supplied genuine V14 client bundle to validate the data models:

```sh
node tools/witcher/validate-core-models.mjs /path/to/foundry.mjs
```

This does not start Foundry or verify sheet/multiplayer behavior. Live acceptance
will be performed on The Forge using the [checklist](docs/witcher/forge-checklist.md).

## Sources

PDFs and extracted pages remain outside the repository. Deterministic importers
record source pages and the PDF hash; they require Python and `pdfplumber`:

```sh
python tools/witcher/import-book.py /path/to/core-v1.35.pdf
python tools/witcher/import-bestiary.py /path/to/core-v1.35.pdf
```

Run the equipment importer first: NPC equipment and loot reference that catalog.
Runtime: `module/witcher/`. Templates: `templates/witcher/`. Source records:
`data/witcher/`. Packs: `packs/witcher/`. Tests: `tests/witcher/`.
Inherited Cyberpunk files outside these paths are not loaded by the manifest.
The original base is retained at tag `cyberpunk-v14-base`.
