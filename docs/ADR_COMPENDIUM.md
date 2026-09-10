# Compendium architecture decisions

Updated 2026-09-10. These decisions supersede the original private PDF importer.
That importer used name hashes, retained composite ROF in a numeric field and
discarded some mechanical annotations. Its output was not lossless.

1. **Stable identity.** Existing pack IDs, paths and document `_id` values are
   fixed in `src/compendia/manifest.json`. Renaming never regenerates an ID.

2. **Reviewable build inputs.** Canonical JSON is checked in. Original imported
   fields are retained in catalog flags. Reviewed overrides and pure normalizers
   generate the runtime fields; LevelDB packs are verified build artifacts.

3. **Explicit mechanics.** Numeric range, capacity and ROF are distinct from
   original table notation. `fireModes` controls available modes. Damage bands,
   skill IDs, AP, armor material, EV and coverage are validated by the same pure
   contract used by runtime preflight. Unsupported variations retain their source
   evidence and require manual resolution.

4. **Definitions versus state.** Offline normalization may initialize new
   compendium ammunition from verified capacity. Updating an owned Item never
   resets ammunition, equipped state, armor damage, humanity loss or limb state.
   Three-way merging preserves customized definitions and reports conflicts.

5. **Honest unknowns.** Missing mechanics do not receive plausible default
   damage, range or ammunition. Manual records list the unresolved rules.
   Placeholder weights become unknown rather than being presented as measurements.

6. **Provenance.** Source codes, reference pages and secondary-source links are
   tracked with corrections. Sourcebook PDFs and extracted prose stay outside
   Git and releases. Secondary-source contradictions remain review items.

7. **Storage and semantics are separate checks.** V14 envelope/LevelDB tests
   remain mandatory. Catalog tests additionally validate every ready record,
   block unsafe manual records, preserve identities, check idempotence and compare
   the checked-in JSON with every compiled pack document.

See [catalog-data-quality.md](catalog-data-quality.md) for the editing workflow,
world update procedure and current limitations.
