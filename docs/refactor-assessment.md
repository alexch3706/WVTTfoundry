# Refactor Assessment

> Historical note (2026-09-08): this assessment predates the V14 port. Compatibility facts in it are retained as project history; use [V14 technical debt](./tech-debt-foundry-version.md) and the [V14 upgrade guide](./v14-upgrade-guide.md) for current release decisions.

Last updated: 2026-09-05

## Purpose

This document answers the immediate brownfield question: how far should refactoring go before new feature work?

## Short Answer

Do not start with a broad modernization refactor. The project is compact and understandable, but it has several risky concentration points. The recommended path is an incremental refactor focused on behavior seams, data mutation discipline, and Foundry compatibility, not a move to a new frontend or build stack.

## Current Maintainability Snapshot

| Area | State | Refactor Pressure |
| --- | --- | --- |
| Foundry bootstrap | Simple and clear | Low |
| Actor data preparation | Centralized but mutates many derived fields | Medium |
| Actor sheet | Understandable, listener-heavy | Medium |
| Item behavior | Large and mixed responsibility | High |
| Weapon/combat rolls | Functional but tightly coupled | High |
| Templates | Clear partial structure | Medium |
| Sass | Simple and localized | Low to medium |
| Migrations | Present but async flow is risky | High |
| Data packs | Large asset surface | Medium to high |
| Tests | None detected | High risk for large refactors |

## High-Value Refactor Targets

### 1. Weapon and Combat Roll Flow

Current state:

- `module/item/item.js` contains fire mode selection, modifier application, attack roll construction, damage rolling, hit-location rolling, ammo updates, and chat rendering.
- Several methods call `roll.execute(...)` or `this.update(...)` without awaiting completion.
- Semi-auto, three-round burst, full-auto, melee, and martial flows have different data shapes and templates.

Recommended refactor depth:

- Extract pure-ish calculation helpers for attack terms, range/DC resolution, shots fired, hit count, and damage aggregation.
- Keep `CyberpunkItem` as the public owner of item behavior.
- Do not introduce a separate combat engine until the existing flows are covered by fixtures or runtime checks.

### 2. Persisted vs Derived Data Boundary

Current state:

- `prepareData` computes many derived actor values by mutating `system`.
- Item armor preparation mutates armor coverage and `lastOwnerId`.
- Some item sheet code directly writes to `cyber.system.humanityLoss` and rerenders instead of using Foundry update APIs.

Recommended refactor depth:

- Document which fields are derived and which are persisted.
- Convert user-triggered persisted writes to Foundry update APIs.
- Avoid changing all derived `prepareData` mutations at once; that would touch many templates and increase regression risk.

### 3. Migration Reliability

Current state:

- Migration is GM-only and version-gated.
- Several migration loops launch async document work without awaiting all results.
- `migrationSuccess` is module-level state.
- Actor skill migration has legacy complexity and likely needs careful runtime verification.

Recommended refactor depth:

- Make migration sequencing explicit and awaitable.
- Keep migration behavior small and easy to reason about.
- Add migration notes/tests/fixtures before changing actor or item data shape.

### 4. Template and Form Consistency

Current state:

- Field partials are good reuse points.
- Dynamic item partials are a useful pattern.
- Some templates contain dense logic or minor malformed/fragile markup.
- Many event hooks depend on CSS classes and `data-*` attributes.

Recommended refactor depth:

- Preserve the existing partial approach.
- Split only dense templates that are actively being changed.
- Do not rename template paths without updating preloads and helper-generated paths.

### 5. Foundry compatibility (historical V12 assessment)

Current state:

- Manifest declares maximum 13, verified 12.
- `getStatNames()` contains a v11/v12 branching attempt.
- The rest of the code is still classic Foundry sheet/document style.

Recommended refactor depth:

- Treat v12 support as a compatibility project, not incidental cleanup.
- Audit Foundry API changes before touching sheet/document base classes.
- Avoid ApplicationV2/DataModel migration unless it is an explicit goal.

## Refactor Scope Recommendation

### Safe Now

- Small local fixes.
- Better awaits around document updates where behavior depends on completion.
- Extract small helper functions from `module/item/item.js`.
- Fix direct persisted writes in user-triggered item sheet actions.
- Improve documentation and comments around derived data.
- Add lightweight fixtures or manual verification scripts.

### Plan Before Doing

- Reworking weapon roll architecture.
- Reworking actor derived data into a cleaner model.
- Changing `template.json` data shape.
- Migrating compendium pack formats or large pack updates.
- Foundry v12 architecture migration.
- Adding a test framework or build toolchain.

### Avoid Unless Explicitly Justified

- Converting the codebase to TypeScript as a side effect.
- Adding React/Vue/Svelte or a standalone frontend model.
- Replacing Handlebars sheets wholesale.
- Introducing npm/bundler workflow before deciding how Foundry packaging will work.
- Broad formatting or style normalization mixed with behavior changes.

## Suggested Refactor Sequence

1. Stabilize current documentation and project context.
2. Pick one feature area, likely combat/ammo/reload or Foundry v12 compatibility.
3. Before changing behavior, write a small technical design for that area.
4. Extract helpers only where they reduce immediate complexity.
5. Verify in Foundry after each behavior slice.
6. Only then consider broader architecture changes.

## Decision Guidance

Use this rule: if a refactor does not directly reduce risk for the next feature or compatibility goal, defer it.

The current project can support incremental feature work. It does not need a rewrite to become productive.
