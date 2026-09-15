# Equipment supplements

Source: the owner's PDFs, kept outside this repository. The importer reads the
published tables directly with `pdfplumber`; no external Witcher system code is
used. The source SHA-256, original table cells, and printed/PDF page mapping are
recorded in `data/witcher/supplement-source-audit.json`.

## Coverage

| Source              | Pages   |                              Entries | Pack                 |
| ------------------- | ------- | -----------------------------------: | -------------------- |
| A Witcher’s Tools   | 3–5     |   16 weapons, 1 shield, 6 armor sets | `supplement-tools`   |
| A Witcher’s Tools   | 5–7     |          23 matching master diagrams | `supplement-tools`   |
| A Witcher’s Journal | 142–143 | 3 hides and 70 alchemical components | `supplement-journal` |
| A Witcher’s Journal | 144     |                          17 mutagens | `supplement-journal` |

Total: **136 items**. Journal's contents, monster sections, loot tables, and final
equipment pages were checked. It adds components and mutagens, not a separate
collection of player swords, armor, bombs, or potion/decoction recipes. Creature
natural attacks and abilities are a separate scope; this import does not turn
harvested venom components into usable poisoned weapons.

All 23 school gear diagrams have product compendium links and per-ingredient
links to the core/Journal components. All weapon profiles include their printed
damage, accuracy, reliability, hands, range, enhancement slots, and properties.
Armor has five independent SP values (torso, arms and legs), EV and enhancement
slots. The Manticore Shield uses dynamic medium shield damage, not a made-up
fixed roll. The 17 mutagens have numeric permanent modifiers, Alchemy DCs and
their specific visible mutations.

## Equipment runtime contract

The following are actual item rules, distinct from creature/profession abilities.
Their data is included; runtime implementation and Foundry validation are tracked
separately in `implementation-status.md`.

### School equipment

All school weapons/shields have `witcherWeapon: true`; `school` records the
school. Core Witcher’s Steel Sword and Witcher’s Silver Sword also need the
Witcher weapon tag. Anyone can use this equipment and its effects (Tools p.3),
subject to an effect's required training. A matching school or Witcher race is
not a prerequisite for an armor trigger.

| Equipped armor | `ability.key`          | Trigger and effect                                                                                                                                                                          |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ursine         | `criticalDecimation`   | A Critical Wound caused with a Witcher weapon rises by one tier. The text does not define a tier above Deadly.                                                                              |
| Feline         | `criticalFlurry`       | After causing a Critical Wound with a Witcher weapon, immediately attempt Disarm or Trip without an additional penalty or STA expenditure.                                                  |
| Griffin        | `criticalSpellcasting` | After the same trigger, immediately attempt a Sign with no additional penalty; pay only its own STA cost. **Deferred with signs/magic.**                                                    |
| Manticore      | `criticalBlock`        | Block or Parry with the Manticore Shield and exceed the attack by more than 4; immediately attempt a Shield Strike without extra penalty/STA. A hit knocks the attacker back 4 m and prone. |
| Serpentine     | `criticalRiposte`      | Parry with a Witcher weapon and exceed the attack by more than 4; immediately attempt one Strike with a held weapon without extra penalty/STA.                                              |
| Wolven         | `criticalMomentum`     | After causing a Critical Wound with a Witcher weapon, immediately attempt one Strike with a held weapon without extra penalty/STA.                                                          |

The follow-up is an attack/check, not automatic damage. The source allows a
Witcher weapon from any school to trigger the armor. Critical-trigger effects
activate after a Critical Wound is actually caused, including the relevant
creature immunity rules. The treatment of a Deadly critical under Ursine Armor
requires explicit adjudication because no fifth tier is printed.

Manticore Shield has `armorClass: medium`, `damage: @shieldDamage`, Rel 20, one
hand, EV 0, AE 1, weight 2, Meteorite and Silver (3d6). Materialize its damage
from Core p.164: lethal Punch two BODY-table levels higher. It must remain usable
as a shield for Block/Parry and as an attacking held weapon. Viper’s Fang is a
Small Blades weapon with Parrying, not a Swordsmanship sword. School crossbows
are one-handed, range 50 m, with Slow Reload; they do not gain strong-attack
damage or BODY melee damage.

Repair lookup must search the supplement pack as well as core diagrams. Some
recipes repeat the same material; allocation must reserve stock across rows
(Ursine Armor has Dark Steel x2 twice, requiring four units).

### Journal processing and mutations

- Crystallized Essence has `ability.key: crushEssence`, Crafting DC 10, 15 minutes,
  one self-linked ingredient and a product link to two Infused Dust. Implement
  consumption/production as processing, without requiring an invented diagram
  or awarding a written-diagram bonus.
- Bear Hide, Boar Pelt and Panther Hide can replace cow hide in making leather.
  Their `leatherSource` flag records this explicit p.142 rule.
- Burdok Root: fields/forests, Poor rarity, Foraging DC 16, successful yield 1d6.
- On successful mutagen preparation, use the item's `bonuses` for the permanent
  effect. Preserve its visible mutation in the actor's effects/notes. The core
  two-mutagen limit and non-Witcher poison rules still apply. Elemental Mutagen
  has Earth/Fire/Ice appearance variants in one published row.
- Journal Troll Mutagen gives **+5 HP**; it must not be silently resolved to the
  core Rock Troll Mutagen, which gives +10 HP.

Vigor bonuses and Griffin's Focus/Critical Spellcasting are recorded for the
later magic implementation. A description or numeric Vigor field alone is not
claimed as functioning spellcasting automation.

## Starting gear and recognition

Tools p.2 offers an **optional** character-creation replacement: give the school's
steel and silver swords, armor and extra weapon where listed (two Viper’s Fangs
for Viper), retain one decoction formula, two oil formulae, two potion formulae
and the medallion, start with 1d6×10 crowns. Page 5 also grants the matching school
gear diagrams. Existing characters must not receive this automatically.

Page 6 states that visible Witcher armor/weapons make the bearer appear to have
Witcher social standing. Education DC 16 can identify the school, with different
social assumptions. This is retained as a roleplaying rule, not a universal
numeric modifier or creature/profession ability.

## Source omissions and normalization

- School gear and diagrams have no printed market price. Their numeric cost is
  the schema default 0, with `priceText` and `sourceOmissions` explicitly stating
  that no market price is given. Diagram investment remains the printed amount.
- Journal mutagen weight and market price are unlisted. The same explicit
  omission flags are used; zero does not assert that they are free or weightless.
- **Ruby Dust x1** in Feline Silver Sword and **Emerald Dust x2** in Serpentine
  Silver Sword have no component entry in the supplied Core/Journal tables.
  Requirements remain exact and unresolved; crafting requires appropriately
  named custom inventory stock. No Gemstone substitution or invented price is
  added.
- Printed `Beast Bone` → core `Beast Bones`, `Arachas Eye` → `Arachas Eyes`,
  `Wyvern Eye` → `Wyvern Eyes`, `Rottfiend Blood` → Journal `Rotfiend Blood`, and
  `Hag Ear` → core `Grave Hag Ear` have explicit aliases in the audit. Printed
  names remain on the recipes, with canonical UUIDs for inventory matching.
- Serpentine Armor's `Linen (4)` is read as four units despite its missing `x`.
  Griffin Silver Sword's printed Etching Acid x2 is retained. Neither is replaced
  with values inferred from the other schools.

## Regeneration and checks

```sh
/root/witcher-reference/.venv/bin/python tools/witcher/import-supplements.py \
  '/root/witcher-reference/pdf/A Witcher’s Tools.pdf' \
  "/root/witcher-reference/pdf/A Witcher's Journal.pdf"
node --test tests/witcher/supplements.test.mjs
```

The catalog tests check all weapon/armor profiles, all mutagen modifiers/DCs,
recipe product/component links, omissions, duplicate-material consumption,
processing data and source coverage. A second import into a temporary directory
is compared byte-for-byte to verify deterministic generation. These checks are
not a live Foundry client or multi-user combat test.
