# Core Bestiary & NPCs

Source: supplied Core Rulebook v1.35. References below use **printed** pages;
the audit also records PDF pages. This is a complete collection of source
records. Creature automation remains under development. No live Foundry run
has been performed.

## Contents: 36 Actors, 253 embedded Items

| Pages | Actors |
| --- | --- |
| 270–275 | Bandit, Mage, Scoia’tael Archer |
| 276–281 | Drowner, Ghoul, Grave Hag |
| 282–285 | Wraith, Noonwraith |
| 286–289 | Wolf, Warg, Werewolf |
| 290–293 | Siren, Griffin |
| 294–297 | Endrega Worker, Warrior, Drone, Queen; Arachas |
| 298–303 | Golem, Fiend, Nekker, Nekker Chieftain |
| 304–309 | Rock Troll, Wyvern, Katakan |
| 310–313 | Cat, Dog, Bird, Serpent, Horse, War Horse, Ox, Mule |
| 318, 321–322 | Woolabag, “Crucible” Kowal, Lord Nowak |

The pack is GM-visible by default. Actors contain printed stats, attacks,
abilities, vulnerabilities and loot. Their prototype tokens are unlinked.
NPC ammunition and named armor are embedded; stock loot links to Item packs.
Loot generation adds items and crowns once. Generic/random loot still requires
a GM choice.

## Connected rules

- Published HP, STA, STUN, REC, ENC, RUN and LEAP survive model preparation;
  explicit overrides retain differences from character formulas.
- Golem has unlimited STA, displayed as ∞. Printed NPC attack damage already
  includes its bonus; BODY is not added again.
- Feral INT, Night Vision, amphibious movement, Siren land stats, resistances,
  immunities, fire weakness, regeneration/Fury and incorporeality affect combat.
- Arachas Back has SP 10 and Rock Troll Stomach SP 5. Aimed weak-spot attacks
  remove natural DR and wear the separate weak-spot armor value.
- Tongue, Webbing, Charge, Thrown Boulder, Spit Venom and Dust Devil use attack
  entries. Shift is an additional defense; Crushing Force prevents parries and
  doubles wear. A bladed parry can sever the Grave Hag's tongue.
- Dedicated actions cover camouflage, invisibility, flight/swimming state,
  sonic screech, drone quills, hypnosis and group ambush rolls. Commands,
  telepathy and illusion descriptions are posted with their applicable action.

## Remaining automation

Printed rules remain visible. Opening a reference does not simulate success.

- High Noon Dance clones, drain/heal and removal.
- Leader followers/aura lifetime; Skull Circle preparation and proximity.
- Teleport destination, charge knockback/collision and flight fall checks.
  Flight currently toggles movement state and stats.
- Golem electrical disruption, sensitive-hearing triggers, blood transference,
  magical scanning and contextual sense/curse interactions.
- Blindly Stubborn rerolls/session uses, mutagen harvesting and random loot.
- Complete placement/duration workflows for Moondust, Yrden and Dimeritium.
  The rules engine recognizes their suppression effects.
- Live sheet, token, multiplayer and concurrent-action acceptance.

Mage spell, ritual and hex lists are included as references; casting is deferred
with player magic.

## Adaptations and omissions

The book gives humanoid/nonhumanoid tables on p.154, not species-specific d10
tables. Assignment by body form is an interpretation. Tables remain editable,
including exceptional anatomy such as Serpent. No invented species probabilities
are represented as printed rules.

Bestiary weapon tables omit damage types. Claws/slashing, bite/piercing and
hooves/bludgeoning are assigned from attack form. Thrown Boulder and Spit Venom
use Athletics; their paragraphs do not specify a skill. These fields are editable.

Warg and Nekker Chieftain use their own stat blocks with the base skills,
weapons and loot. Endrega variants share the base block plus their individual
weapons/abilities. Endrega Queen uses Arachas as directed on p.294. Bandit level
suggestions give ranges and choices, so no arbitrary veteran block is invented.

Kowal's Hand Crossbow has blank ROF; standard crossbow ROF 1 is used. Woolabag
uses Rock Troll and Branch Club; the source supplies no Melee rank for the club,
so none is invented. Its printed “+1 Stun” is represented as −1 to the save
threshold. Unnamed NPC armor retains printed SP without invented price or EV.
Loot aliases include “Vampie saliva” → Vampire Saliva and Wraith Essence →
Essence of Wraith.

## Verification

Nine bestiary tests cover the roster, published derived values, variants, weak
armor, unlimited STA, immunity, regeneration and Siren/Ox exceptions. The official
CLI builds an Actor LevelDB pack and reads back every Actor and embedded Item.
Genuine V14.365 fields accept all records; supplied fields are checked recursively
for silent cleaning losses. These checks do not launch Foundry.

Source: `data/witcher/bestiary.json`; audit: `data/witcher/bestiary-audit.json`;
deterministic importer: `tools/witcher/import-bestiary.py`.
