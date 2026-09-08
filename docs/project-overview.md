# Cyberpunk2020VTT Project Overview

Last updated: 2026-09-08

## Executive Summary

Cyberpunk2020VTT is a FoundryVTT game system package for R. Talsorian Games' Cyberpunk 2020. The repository is a single-package Foundry system, not a standalone web application. Foundry loads it directly through `system.json`, runs JavaScript modules in the Foundry client runtime, renders Handlebars sheets/templates, and loads data from Foundry compendium pack files.

The codebase is compact and brownfield: most behavior lives in plain JavaScript files under `module/`, while sheet presentation is split between Handlebars templates under `templates/` and Sass under `scss/`. There is no package manager workflow, bundler, or TypeScript layer; a Node-based regression runner covers combat mechanics and selected UI/data contracts.

## Project Classification

| Attribute | Current State |
| --- | --- |
| Repository type | Monolith |
| Runtime type | FoundryVTT system package |
| Primary language | Plain browser JavaScript ES modules |
| UI layer | Foundry `ActorSheet` / `ItemSheet` plus Handlebars `.hbs` templates |
| Styling | Sass source compiled to tracked CSS |
| Data model | Foundry `template.json` system template |
| Data assets | Foundry LevelDB compendium directories under `packs/` |
| Localization | `en`, `es`, `it` language files |
| Tests | `node tests/run-combat-fixtures.mjs` plus GitHub Actions CI |

## Technology Summary

| Category | Technology | Version / Source | Notes |
| --- | --- | --- | --- |
| Foundry package | `cyberpunk2020-rilerena` | `system.json` version `2.0.0` | V14 only; API/manifest target `14.365`, pending live-world sign-off |
| Runtime entry | ES module | `module/cyberpunk2020-rilerena.js` | Loaded through `system.json -> esmodules` |
| Actor layer | Foundry `Actor` subclass | `module/actor/actor.js` | Computes derived character data and rolls |
| Item layer | Foundry `Item` subclass | `module/item/item.js` | Handles weapons, armor, vehicles, and item rolls |
| Sheets | Foundry sheet subclasses | `module/actor/actor-sheet.js`, `module/item/item-sheet.js` | jQuery-style `activateListeners(html)` event wiring |
| Templates | Handlebars | `templates/` | Preloaded through `module/templates.js` |
| Styling | Sass | `scss/cyberpunk2020-rilerena.scss` | Compiled artifact is `css/cyberpunk2020-rilerena.css` |
| Compendia | Foundry V14 LevelDB packs | `packs/*/` | 28 declared packs / 2,124 schema-audited documents |

## Current Capability Surface

- Character and NPC actor sheets share the same data preparation flow.
- Character creation can seed default skill items from the `cyberpunk2020-rilerena.default-skills` pack.
- Actor data preparation computes stat totals, armor stopping power by hit location, encumbrance REF modifier, movement, carry/lift, body type modifier, wounds, humanity loss, and EMP total.
- Actor sheet tabs cover skills, combat, gear, cyberware, and life notes.
- Item sheets support skill, weapon, armor, cyberware, vehicle, and misc item types through dynamic partials.
- Weapon rolls support semi-auto, three-round burst, full auto, melee, and martial-art flows at varying completeness levels.
- Chat output uses reusable roll cards and multi-hit cards.
- Migrations exist for old actor skill data, token defaults, item source fields, and weapon range damage scaffolding.

## Refactor Context

This project is small enough that a targeted refactor is feasible, but broad modernization would be a major architectural change. The highest-value refactor work is not introducing a new stack; it is stabilizing existing Foundry patterns, reducing direct data mutation, making roll flows more coherent, and improving migration/testability boundaries.

See [Refactor Assessment](./refactor-assessment.md) for recommended refactor depth and risk zones.
