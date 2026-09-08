# Project Documentation Index

Last updated: 2026-09-08

## Project Overview

- **Project:** Cyberpunk2020VTT
- **Type:** FoundryVTT system package
- **Repository structure:** Monolith
- **Primary language:** Plain JavaScript ES modules
- **Architecture:** Foundry document/sheet/template architecture
- **Current package version:** `2.0.0`
- **Foundry compatibility:** V14 only; verified against the `14.365` API/manifest target, pending live-world sign-off

## Quick Reference

- **Runtime entry:** `module/cyberpunk2020-rilerena.js`
- **Manifest:** `system.json`
- **Data template:** `template.json`
- **Actor logic:** `module/actor/actor.js`
- **Actor sheet:** `module/actor/actor-sheet.js`
- **Item logic:** `module/item/item.js`
- **Item sheet:** `module/item/item-sheet.js`
- **Templates:** `templates/`
- **Sass source:** `scss/cyberpunk2020-rilerena.scss`
- **Compiled CSS:** `css/cyberpunk2020-rilerena.css`
- **Compendium packs:** LevelDB directories under `packs/`

## Generated Documentation

- [Resolver Contracts Reference](./resolver-contracts.md)
- [Rule Reference Policy](./rule-reference-policy.md)
- [Project Overview](./project-overview.md)
- [Architecture](./architecture.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [Component and UI Inventory](./component-inventory.md)
- [Data Models and Assets](./data-models.md)
- [Development Guide](./development-guide.md)
- [Foundry V14 Upgrade Guide](./v14-upgrade-guide.md)
- [Refactor Assessment](./refactor-assessment.md)
- [V14 Verification Checklist](./verification-checklist.md) — release sign-off checklist for Foundry runtime checks
- [Combat Mechanics Audit](./combat-mechanics-audit.md) — adherence check between Combat Resolver and Corebook rules

## Existing Documentation

- [README](../README.md) - upstream/user-facing project overview and development note

## Getting Started for AI Agents

1. Read [Architecture](./architecture.md) for runtime structure.
2. Read [Refactor Assessment](./refactor-assessment.md) before proposing broad refactors.
3. Use [Development Guide](./development-guide.md) for verification expectations.
4. Use [Data Models and Assets](./data-models.md) before changing `template.json`, packs, actor/item fields, or migrations.
5. For mechanics fidelity work, use local rulebook source artifacts outside public version control and cite only paraphrased page references in committed docs.

## Documentation Purpose

This documentation captures the current brownfield state so future PRD, architecture, and story workflows can decide how much refactoring is justified before feature work.
