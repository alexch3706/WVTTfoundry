# Tome alchemy catalog

`tools/witcher/build-alchemy.mjs` reproducibly builds `data/witcher/tome-alchemy.json`:
**7 elixirs, 7 formulas, Penitent Mutagen and the named Feline Brain ingredient — 16 Items.**
Product/material links resolve to stable Item IDs in this pack and the existing Core packs.
Catalog availability alone does not establish runtime automation; consumption support belongs to the alchemy runtime.

## Sources and transcription

All page numbers below are printed pages of **A Tome of Chaos v1.01**. Physical PDF page numbers are one larger.
The supplied PDF has SHA256 `239d63bdf0e7bcd70f062fafb84b6b63dfa110aea62e3e28368a78a9c20a5c88`.
The graphical p.116 ingredients were visually checked against the actual PDF and Core v1.35 p.142's substance legend; they were not inferred from OCR.

| Formula, p.116    | DC / time       | Substance units, plus **one bottle of Alcohest**   | Formula price |
| ----------------- | --------------- | -------------------------------------------------- | ------------: |
| Anabolic Steroids | 16 / 30 minutes | Rebis1, Caelum1, Quebrith1, Hydragenum2            |           330 |
| Last Hope         | 22 / 1 hour     | Sol2, Vitriol1, Aether2, Vermilion3                |           400 |
| Lightning         | 16 / 15 minutes | Vitriol2, Vermilion2, Hydragenum2                  |           150 |
| Mongoose          | 15 / 15 minutes | Rebis2, Aether2, Fulgur2                           |           100 |
| Strider           | 16 / 15 minutes | Rebis2, Aether1, Fulgur1, Caelum1                  |           128 |
| Tempest           | 15 / 15 minutes | Vitriol1, Aether1, Quebrith1, Caelum1, Hydragenum1 |           104 |

Both p.116 recipe tables are headed **Journeyman**, including Last Hope at DC22. Each recipe retains that printed grade.
Each graphical substance resolves to the canonical pure-substance Item, while its `substance` field allows the crafting allocator to consume appropriate botanical/monster substitutes.
No arbitrary fifth essence is added to the printed formulas.

**Cerebral Elixir, p.147:** Master Alchemy DC22, 10 hours, investment666, formula price1332.
The named ingredients are Alcohest3, Feline Brain1, Hallucinogen1, Hellebore Petals3, Mandrake Root5, Crow’s Eye3, Wolfsbane4, Silver1, Han Fiber4.
These rows have no substance wildcard: a different Aether plant cannot replace the explicitly named hellebore.
The listed three Alcohest bottles are the complete requirement; p.116's extra bottle is not applied again.
The elixir protects specifically against a **bes** for 24 hours and immediately expels a bes if consumed while already possessed. It is taken at the beginning of a summoning ritual.

**Penitent Mutagen, p.210:** blue, Alchemy DC18, +2 Vigor Threshold, glowing white markings.
The Bear Mutagen already supplied by the Journal pack is not duplicated.

## Durations and omissions

The existing Item `system.duration` is in three-second rounds: Anabolic200, Mongoose600, Strider28800, Cerebral28800.
`flags.witcher-rilerena.alchemy` supplies canonical slugs and actual seconds for runtime consumers.
Anabolic Steroids additionally records a separate one-hour aggression duration.
Last Hope lasts until the specified medical reopening/treatment; Lightning until the next physical attack.
Tempest has no printed duration; its flag and visible description preserve that omission.

Cerebral Elixir has no printed toxicity or sale price. Both omissions are explicit, including an alchemy-level `toxicityUnspecified` flag.
Numeric zero fields required by the Item schema are placeholders and are not source rules.
Feline Brain has no printed substance class, weight or price. Penitent Mutagen has no printed weight or price.
The six p.116 formulas have no printed weight or investment. Missing values are flagged and explained in the Items.

## Verification

`node --test tests/witcher/tome-alchemy-catalog.test.mjs` checks independent ingredient transcription, exact printed prices/DC/time/grade,
all linked products/materials, deterministic serialization/IDs, named-ingredient allocation, duration units and omissions.
Runtime tests separately verify authoritative consumption and real effect consumers.
