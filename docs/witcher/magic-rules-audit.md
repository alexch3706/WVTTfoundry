# Magic rules audit

Sources checked: **The Witcher Core Rulebook v1.35**, printed pp.48, 70, 78,
99–115, 122–123 and 166–168; **Core Errata 2022**; **A Tome of Chaos v1.01**,
printed pp.8–9 and 101; **A Witcher's Tools**, Griffin equipment pp.3–4.
These notes describe the rules and decisions used by the pure helpers in
`module/witcher/magic-rules.js`. They do not certify that every spell in either
book has runtime automation.

The publisher's [Core Errata](https://rtalsoriangames.com/wp-content/uploads/2022/03/RTG-WI-WitcherCoreErratav4.pdf)
confirms the cumulative Vigor rule, the revised Quen and Active Shield, the
defense entries, and the distinction between physical magical damage and other
magic for critical injuries. Those corrections are already present in the local
v1.35 book. An additional search of the publisher's site did not locate a later
correction to Aard's percentage or a universal rule for rounding magic costs.

## Casting, costs and concentration

- Spell attacks use **WILL + Spell Casting + the normal exploding d10 check**.
  Armor EV penalizes Spell Casting, Ritual Crafting and Hex Weaving (Core p.78).
- Vigor limits the **total magical STA cost in one round**, not each individual
  cast. Separate extra-action/defense charges consume STA but are not an
  additional quantity of magic cast. A cast which raises that round's magic
  expenditure above Vigor costs 5 HP per newly exceeded point. Previously paid
  excess must not be charged again on the next cast (Core p.166).
- Overexertion also causes the applicable elemental consequence. If there is
  no actual check fumble, there is no additional rolled fumble-damage number;
  the overexertion damage is already the 5 HP per excess point.
- The full STA cost is still required. Overexertion exchanges HP for exceeding
  **Vigor**, not for missing STA. Reaching zero STA triggers the existing
  exhaustion/unconsciousness rules; callers must apply them.
- One held focus can reduce the STA cost, to a minimum of 1 (Core p.167).
  Focuses do not stack. The sign's chosen strength is recorded separately from
  discounted expenditure, so a focus discount does not weaken an effect.
  The base text names Mages and Priests; Griffin swords in _A Witcher's Tools_
  explicitly provide Focus (1), so a blanket ban on witchers using a focus would
  discard the supplement's equipment effect.
- An active spell costs the indicated STA each subsequent round and prevents
  the caster from casting other spells while maintaining it (Core p.102).
  That sidebar does **not** assign a separate action to paying maintenance.
  Fire Stream explicitly permits changing targets on the caster's turn.
- Ordinary spell components depend on the actual Spell Casting skill rank:
  ranks 1–6 need words and gestures; 7–8 need gestures; 9–10 permit very small
  gestures using any body part (Core p.167). Sign-specific hand injuries and
  spell-specific requirements need their own validation.

### Fractions and focus-aware maintenance

Fire Stream requires half the initial STA, and Dispel/Heliotrope require half
the original casting STA. The book's rounding sidebar (p.48) concerns **derived
statistics**, so it is not evidence for rounding these costs down. The helpers
retain the exact half, including 0.5 STA. Actor resource fields accept fractions.

For an active sign, pass the original **actual expenditure** to
`magicMaintenance`; do not apply the same focus discount again to that result.
For fixed-upkeep mage spells, the book does not explicitly describe whether a
focus discount can also reduce the separate upkeep number. This requires a
declared rule before extending automation to those cases.

## Failures and elemental consequences

The fumble magnitude is the complete negative continuation after the initial
d10 result of 1, including any exploding 10s (Core pp.57,166).

| Fumble magnitude | Result                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| 1–6              | Suffer that much damage; the spell still resolves.                                                         |
| 7–9              | The spell fails; suffer that much damage and its elemental consequence.                                    |
| 10+              | As the serious failure, plus destruction of carried focusing items and a 1d10-damage, 2m-radius explosion. |

| Element | Additional consequence                                         |
| ------- | -------------------------------------------------------------- |
| Earth   | Stunned.                                                       |
| Air     | Pushed 2m.                                                     |
| Fire    | Set on fire.                                                   |
| Water   | Frozen.                                                        |
| Mixed   | GM randomly determines one of the four elemental consequences. |

Mixed magic does not inflict its numeric fumble damage twice. Priests use the
Mixed result regardless of the appearance of their invocation. Tome's Druid
and Ley Line rules require their own overrides. Somne and Supirre do not list
an element in Tome p.101: a caller must obtain a GM elemental ruling if a
backlash requires one, rather than silently labelling either sign Water.

Rituals instead inflict damage equal to the ritual's STA cost on a fumble.
Hexes instead have a 50% chance to afflict the caster; they do not use the normal
elemental damage table (Core p.168).

**Textual conflict:** Core p.168 says willing-target, self and undefended area
magic requires a roll without a fumble. Core p.166 explicitly says a 1–6 magic
fumble still produces the spell. The shared `magicalFumble` helper follows the
specific outcome table and reports success for 1–6; callers must retain this
decision consistently rather than having self buffs and attacks accidentally
resolve the same fumble in different ways.

## Defenses and counter magic

- `Dodge` permits Dodge/Escape **or Athletics**, unless the individual entry
  explicitly names only one (Core p.99 and Errata).
- `Block` permits a normal block. It does not add Parry to the listed choices.
- `Resist Magic` uses that skill; a STAT×3 entry supplies a fixed opposing DC.
- `None` does not prevent Dispel or Heliotrope from countering magic.
- Dispel (Core p.102): within 10m, spend half the original casting STA and
  **beat** its original casting total with Spell Casting. It can remove a
  lasting spell/ritual/hex and can be used defensively against a magical attack
  whether that attack has a physical component or not.
- Heliotrope (Core p.70): when targeted by a spell, invocation or hex, spend half
  its casting STA and **equal or beat** the original roll using WILL +
  Heliotrope. Success negates the effect; it does not merely halve its damage.
  This is a profession skill, not one of the twelve freely learned sign Items.
- Each affected creature defends against the area spell's casting total. A
  creature being geometrically inside an area is not itself a failed defense.

## The twelve signs

Chosen sign strength is an integer from 1 through 7. Somne's text only provides
the four values shown below, so its offered choices are restricted accordingly.

| Sign          | Resolved rule                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Yrden         | Stationary 3m-radius circle for 5 rounds. SPD and REF penalty `1 + floor((power−1)/2)`, maximum4; removed on exit. Incorporeal creatures inside become corporeal.                                                                                                                                                                    |
| Quen          | 5 shield HP per power; 10 rounds or depletion; cannot recast while the existing shield remains.                                                                                                                                                                                                                                      |
| Aard          | 2m cone, Dodge. Staggers; printed base10% knockdown chance plus10 percentage points per STA.                                                                                                                                                                                                                                         |
| Igni          | 2m cone, Dodge or Block. `power d6` fire damage, 50% ignition; torso unless aimed at point-blank range.                                                                                                                                                                                                                              |
| Axii          | 8m, Resist Magic. Stunned until a successful Stun save with penalty `−(1 + floor((power−1)/2))`. The separate persuasion use is visible to observers.                                                                                                                                                                                |
| Magic Trap    | Prepare over one round; 3m-radius stationary trap lasts `power` rounds. Attacks the closest enemy once per round with WILL + Spell Casting, for3d6. Dodge or Block.                                                                                                                                                                  |
| Active Shield | 10 shield HP per power, initial-cost upkeep. Tangible objects cannot cross either direction. Caster cannot run; one person can share by pressing against the caster. On depletion or dismissal, adjacent objects/allies/enemies take1d6 torso damage and a2m push. Rooted targets or those over226kg take the damage without moving. |
| Aard Sweep    | 4m-radius sphere, Dodge. A single `10 × power`% chance produces both stagger and prone. Can knock down a flying creature.                                                                                                                                                                                                            |
| Fire Stream   | 3m, Dodge or Block. `power d6` fire, 75% ignition, body location can be aimed. Half-initial-cost upkeep; caster may switch target on their turn.                                                                                                                                                                                     |
| Puppet        | 8m, Resist Magic. Target becomes an ally for `power` rounds, with a Resist Magic attempt each round against the original casting total.                                                                                                                                                                                              |
| Somne         | 8m, Resist Magic, eight hours asleep/counting as stunned. Damage always wakes. At2STA, noise or waking also suffices; at4STA waking takes an action; at6STA a full-round action; at7STA only damage.                                                                                                                                 |
| Supirre       | Draw on a surface; one listening point within `2 × power` metres for ten minutes. No Awareness roll needed for a conversation there; choosing another listening point requires recasting.                                                                                                                                            |

**Aard interpretation:** unlike Yrden and Axii, Aard's wording does not say
“beyond the first”. The helper uses the literal base10% +10% per point, i.e.
20–80% at powers1–7. Aard Sweep explicitly uses10% per point, i.e.10–70%.
No correction to this distinction was found in the supplied Errata.

**Geometry:** Core gives a cone's reach but not its angle. A configured GM
angle must be identified as table geometry, not claimed to be printed rules.
Aard Sweep expressly describes a sphere: the scene's circle footprint alone
does not prove that a flying token at any elevation is inside it.

## Quen ordering and remaining judgment calls

Resolve Quen against incoming **raw** lethal or nonlethal damage. Its remaining
HP decreases first; only overflow proceeds through the wearer's armor,
resistances and hit-location multiplier. Sequential hits and multiple locations
must share one shield budget. A shield that was already at0HP must not produce
a second Active Shield collapse event.

Quen does not intercept magic whose defense does not permit Block, nor ongoing
poison, disease or oxygen deprivation. Internal bleeding is likewise not a new
incoming attack. The helper accepts the damage source separately so these
effects cannot accidentally consume shield HP.

The books checked do not separately explain a critical hit which is fully
absorbed by Quen. Preventing its critical wound and bonus damage while no attack
reaches the wearer is a shield-interception interpretation, not a separately
printed exception. Magic can normally create critical wounds only when it
strikes with a physical component/force (Core p.166), not simply because its
damage number is nonzero. Magic Trap's unspecified damage form must not be
silently treated as a physical projectile to grant critical wounds.

## Tome mechanisms that need separate workflows

Tome pp.8–9 add Ley Lines, not merely a flat universal Vigor bonus:

- Mages, Priests and Druids spend an action and beat Spell Casting DC16 while
  touching the line to connect; moving away severs the link. A failed attempt
  gives its elemental consequence without additional damage. Witchers and
  lesser magical talents cannot establish this connection.
- A connected Mage can cast only that line's element. Earth imposes−4 on
  defenses; Air lends access to spells of an already-known tier without
  permanently learning them; Fire adds two damage dice and raises existing
  ignition chances to100%; Water adds2 to Spell Casting.
- Those benefits have distinct extra overdraw/fumble effects: broken
  connections and increasing reconnect DC, a substituted air spell, a forced
  second fire casting at a random target, or GM-controlled water hallucinations.
- Connected Priests/Druids instead get+4 Vigor; each mishap adds a cumulative
  −2 Vigor for six hours. At0 or below they cannot cast until it rises again.

Core p.122 Places of Power are another workflow: three focusing turns, the
specified elemental benefit and learning IP or extraction of Fifth Essence,
with escalating repeated-use risk. Core p.123 learning requires the correct
profession, IP, study time and successful casting-skill checks. These cannot be
represented accurately by an unrestricted “learn all” button.

Tome's invocations, rituals, enchantments, mutation, necromancy and goetia have
additional resource, time, component and mishap rules. They require their own
audited application paths. A reference Item alone is not an implemented effect.

## Helper contract

- `magicCostPlan`: validated cost, before/after round load, newly owed HP,
  remaining STA and exhaustion/backlash flags. Caller supplies one eligible
  focus and separately validates actor permissions/components/action economy.
- `magicalFumble` and `elementalBacklash`: no RNG or document changes. Caller
  rolls any requested mixed-element outcome and applies conditions, damage,
  focus destruction/explosion and displacement authoritatively.
- `signParameters`, `magicDuration`, `magicMaintenance`: resolved numeric
  properties; no claims that an effect has been applied to a scene or actor.
- `magicDefenses`: permitted defense kinds; caller checks learned counters,
  costs, range and permissions.
- `absorbQuen`: raw remainder and next shield HP; caller applies the remainder
  through the normal damage pipeline and persists shield changes atomically.

Two explicit casting preflight guards are used by `magicCostPlan`: no casting
at zero Vigor and no casting while marked in direct dimeritium contact. The book
describes direct contact as preventing average casters from summoning magic and
reducing Vigor to0; any profession/supplement feature overriding that restriction
must resolve before calling the standard guard. Nearby dimeritium instead
reduces the Vigor value supplied to the helper by1 per unit within5m.
