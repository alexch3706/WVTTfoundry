# Verbal Combat: source audit and implementation requirements

Status: **source audit retained as the implementation specification**. The implemented workflow and validation are described in [social-combat.md](social-combat.md). References below to preimplementation gaps describe the audit baseline. The rules are optional (Core pp. 175–177); ordinary conversations and individual social checks remain usable.

## Sources and notation

Sources are the supplied books, using **printed page numbers**:

- _The Witcher Core Rulebook_, v1.35, pp. 176–177: the complete Verbal Combat procedure, attacks, defenses, tools, and sidebars.
- Core pp. 48–49, 57–58: derived statistics, skill attributes, standard checks, opposed checks, criticals, and fumbles.
- Core pp. 21, 24, 60: social standing, relevant human traits, Reputation and Face-Down.
- Core pp. 151, 156–157: ordinary combat timing, physical injury thresholds, and physical fumbles; these are not a separate social critical table.
- _Core Errata 2022_, entry for p. 177: adds the modifiers sidebar already incorporated into v1.35. It must not be applied twice.
- _A Tome of Chaos_, v1.01, pp. 124–125, 133, 140–144, 148–149: trophies, reanimated corpses, demon negotiations, binding, and the True Staff of Binding.

`EMP`, `INT`, and `WILL` below mean the character's applicable attribute. A **check attribute** and a **damage attribute** are separate values. For example, Deceit checks use EMP but Deceive damage adds INT.

Where the text leaves a choice unresolved, this audit labels it as an **open ruling**. These are not additional rules. A complete implementation must expose a recorded table convention or request an adjudicated input rather than silently inventing a DC or effect.

## Encounter lifecycle and Resolve

Core p. 176 establishes the following sequence:

1. Each party states its goal for the argument.
2. Each participant determines Resolve: `((WILL + INT) / 2) × 5`.
3. On a turn, choose an attack and its opponents, or spend the full turn using a tool.
4. Each attacked opponent selects a defense and makes the appropriate opposed check.
5. The higher result deals that move's Resolve damage. Each successful defender can deal damage back to the attacker.
6. A participant reduced to zero Resolve loses and is convinced of the opponent's argument. The final successful move can carry a specific outcome, such as agreement, belief in a lie, or friendship.

Resolve belongs to **this argument**, not the actor's HP or STA. The section gives no Resolve healing action or rule for carrying depleted Resolve into a new argument. Preserve a completed encounter's history; initialize a new encounter separately.

**Rounding:** Core p. 48 tells readers to round derived statistics down, but p. 176 does not specify whether Resolve rounds the average before multiplying by five or rounds the final expression. With WILL 5 and INT 4 these produce 20 and 22, respectively. This must be an explicit rule interpretation, not an unexplained formula change. With equal attributes of 6, the result is unambiguously 30.

### Multiple opponents

One attack can address any or all opponents. Each gets a defense, and each successful defender deals its applicable damage to the attacker (Core p. 176). This requires independent defense results and target state; it cannot be implemented as a single group defense or a single return-damage payment.

The text does not specify:

- whether an attack shares one damage roll across targets or rolls damage for each;
- whether cumulative Seduce/Appeal/Intimidate effects are specific to a particular attacker;
- how an already-declared exchange completes if return damage reduces the attacker to zero midway through resolving targets;
- how simultaneous victories, conflicting goals, or multiple winners settle;
- whether a successful Disengage removes one participant or ends the whole group argument.

Record these conventions in the encounter. Do not let target iteration order accidentally decide them.

## Checks, ties, criticals, and fumbles

Use the existing standard Witcher check procedure (Core pp. 57–58): attribute + skill + an exploding d10, including the natural-1 negative continuation and natural-10 positive continuation. Manual die entry must use the same validation as ordinary checks. Applicable wound, magic, hex, racial, and contextual modifiers still matter.

- Opposed checks: the defender wins ties (Core p. 57).
- A printed numeric/stat-derived DC: the roll must **exceed** the DC; equality fails (Core p. 57).
- Natural 10 and natural 1 change the roll through the ordinary critical/fumble procedure; they do not create a new automatic social success or automatic catastrophe.
- There is no social critical-wound table, margin-of-success injury bonus, weapon fumble table, or spell backlash in pp. 176–177. Do not invoke those physical/magic mechanisms for verbal checks.
- Core p. 156 clamps a combat fumble result to zero. Applying this general combat rule to Verbal Combat should be documented with the other inherited combat conventions.

**Tie damage is an open ruling:** the general rule awards a tied opposed check to the defender, while p. 176 awards damage to the person rolling _higher_, and Counter-argue says to beat the opposing roll. Thus a tied defense clearly prevents the incoming attack under the general rule; whether it also deals defensive damage or triggers Disengage is not resolved expressly by this section. Keep success/blocking separate from permission to apply return damage so this can be decided consistently.

## Attacks

Every attack check uses its normal skill attribute (Core p. 49); the damage expression and rider come from Core p. 176.

| Family       | Attack     | Check                  | Resolve damage  | Additional result                                                                                               |
| ------------ | ---------- | ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| Empathetic   | Seduce     | EMP + Seduction        | `1d6 + EMP`     | Cumulative +2 damage from Seduction during this combat.                                                         |
| Empathetic   | Persuade   | EMP + Persuasion       | `1d6 / 2 + EMP` | A combat-finishing success wins agreement.                                                                      |
| Empathetic   | Appeal     | EMP + Leadership       | `1d10 + EMP`    | Each successful Appeal adds cumulative +1 damage from empathetic attacks against that defender.                 |
| Empathetic   | Befriend   | EMP + Charisma         | `1d6 + EMP`     | A combat-finishing success advances the friendship described below.                                             |
| Antagonistic | Deceive    | EMP + Deceit           | `1d6 + INT`     | A combat-finishing success convinces the defender of the lie.                                                   |
| Antagonistic | Ridicule   | INT + Social Etiquette | `1d6 + WILL`    | Each successful public Ridicule reduces the target's Reputation with those witnesses by 2 for one day.          |
| Antagonistic | Intimidate | WILL + Intimidation    | `1d10 + WILL`   | The target becomes afraid of this attacker and takes cumulative +4 damage from Intimidation during this combat. |

The empathetic/antagonistic sidebar explains likely relationship consequences, not an automatic permanent enemy flag after every antagonistic win. Intimidation's narrative fear is not expressly converted into a physical fear condition or a magical fear effect.

### Cumulative attack effects

Store successful exchanges as receipts and derive counters from those receipts. Apply each exchange once. Core does not clearly settle whether Seduce/Intimidate increase damage on the triggering hit or only later hits, or whether their wording counts failed attempts; Appeal expressly counts successful uses. Likewise, it does not expressly settle whether a second attacker benefits from another attacker's accumulation. These are required conventions before enabling automatic damage.

Persuade's `1d6 / 2` can produce halves. The attack table gives no rounding direction. The derived-statistics rounding instruction is not expressly a universal damage rounding rule. Preserve the expression until a sourced/general rounding policy or explicit table convention is selected.

### Friendship

Core p. 176, “Making Friends,” gives persistent relationship progression for **combat-finishing Befriend victories**, not each successful ordinary Charisma check:

1. Acquaintance: friendly and will not act against the victor without good reason.
2. Dedicated friend: likely to help and do things for the victor.
3. Blood-brother: willing to do almost anything reasonable.

Track who befriended whom, the completed encounters, and the resulting level. No automatic obedience beyond the stated limits is justified. The text does not define progression beyond the third success or a symmetric relationship update for both actors.

## Defenses

Core p. 177:

| Defense            | Check                            | Resolve damage on a damaging success | Additional result                                                             |
| ------------------ | -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Ignore             | WILL + Resist Coercion           | `1d10 + EMP`                         | None.                                                                         |
| Counter-argue      | The chosen attack's normal check | The chosen attack's damage           | Negates the incoming attack and makes the selected attack against its source. |
| Change the Subject | EMP + Persuasion                 | `1d6 + INT`                          | None.                                                                         |
| Disengage          | WILL + Resist Coercion           | None                                 | Ends the argument.                                                            |

Counter-argue is one defense in the current exchange. It must not create an unbounded sequence of counter-counter declarations. The rule calls it an attack and references the attack table; applying the chosen attack's riders and finishing outcome is the natural reading, but that reading should be documented rather than treated as an additional independently printed sentence. Do not charge a second normal action without an explicit action-economy ruling.

Disengage is a defense, not an automatic unconditional exit button. The general opposed procedure supplies its contest; no independent fixed DC is printed. Tie and group-exit handling remain the open rulings above.

## Tools

Tools replace the attack and take the full turn. None deals Resolve damage (Core pp. 176–177).

| Family       | Tool    | Check                                         | Printed result                                                                                                                                                                                                                                 | Unspecified input/ruling                                                                                                               |
| ------------ | ------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Empathetic   | Romance | EMP + Charisma                                | The target falls in love and has −3 against this romancer in Verbal Combat while the romancer maintains the convincing, caring relationship. If it ends badly, the target instead has permanent +3 against this romancer's empathetic attacks. | No resistance skill or DC is printed. Duration is conditional, not a fixed timer; repeated/overlapping romances are not explained.     |
| Empathetic   | Study   | EMP + Human Perception against target INT × 3 | Success grants +2 to Verbal Combat for one round. Equality fails.                                                                                                                                                                              | Exact round expiry and whether the benefit applies only against the studied opponent are not spelled out.                              |
| Antagonistic | Imply   | EMP + Persuasion **or** EMP + Deceit          | Success lowers the opponent's defenses by 4; only usable once per combat.                                                                                                                                                                      | No resistance skill or DC is printed. Attempt-versus-success consumption and exact effect duration are not explicit.                   |
| Antagonistic | Bribe   | EMP + Gambling                                | On success, each 50 Crowns offered grants +1 to empathetic Verbal Combat rolls for the rest of the fight.                                                                                                                                      | No resistance skill or DC is printed. Transfer timing, repeated offers, and how incomplete 50-Crown increments count are not explicit. |

Do **not** copy Study's INT × 3 DC onto the other three tools. Their missing opposition must be adjudicated and recorded before their effects can be committed.

Romance belongs to a directed relationship, not a global −3 on all of an actor's skills. Its aftermath needs an explicit end-badly operation and retains its named opponent.

Bribe refers to an offer, not an explicit immediate debit on every attempt. Track offered, accepted, and transferred amounts separately. If implementing whole 50-Crown increments with `floor(amount / 50)`, label that interpretation. Validate available currency for an actual transfer, support rollback, and never silently consume money from a failed check.

## Situational modifiers and actual torture

The p. 177 modifiers sidebar leaves circumstances to the GM and suggests magnitude 1 for mild, 3 for moderate, and 5 for major circumstances. The sign depends on the situation. Show modifier source and scope so the same circumstance is not counted twice.

“Torture & Torment” requires both a target at the interrogator's mercy and **actual damage inflicted**:

- Harming that target gives −3 to empathetic attack checks and +3 to Intimidation.
- Bringing that target to its wound threshold gives −10 to empathetic attack checks and +10 to Intimidation.

Although the introduction refers generally to antagonistic attacks, the numeric bonus specifically names Intimidation. Do not grant it to every antagonistic skill. These are check modifiers, not Resolve damage bonuses.

Do not invent Torture or Torment skills, free HP damage, or a button that merely asserts the condition without a real damage/adjudication record. Core p. 156 uses HP below the wound threshold for physical wound state; p. 177 says down to the threshold. Equality at the boundary and whether the severe modifier replaces rather than stacks with the mild one need an explicit ruling. Duration and interpersonal scope are not separately specified.

## Standing, reputation, race, and audience

### Social standing (Core p. 21)

| Standing  | Applicable modifiers                                |
| --------- | --------------------------------------------------- |
| Equal     | None.                                               |
| Tolerated | −1 Seduction, Charisma, Persuasion, and Leadership. |
| Hated     | −2 to the same four skills.                         |
| Feared    | +1 Intimidation and −1 Charisma.                    |

Standing depends on the actual audience and territory; people of the same race are normally equal absent personal problems, and existing friends/lovers can supersede general hostility. Hated and Feared can coexist. Feared is not another step in the Hated → Tolerated → Equal progression. Do not apply standing penalties to every EMP skill.

Humans' Trustworthy trait grants +1 Charisma, Seduction, and Persuasion against humans (Core p. 24). Human Blindly Stubborn permits the stated limited rerolls of failed Resist Coercion/Courage checks; it requires its actual per-session use tracking and cannot recursively reroll the same reroll. Cat School immunity to nonmagical charm attempts is a separate eligibility question; the source does not provide a list classifying all seven verbal attacks as charm, so it must not become universal immunity to Verbal Combat.

### Reputation (Core p. 60)

Recognition is an ordinary unmodified d10 roll less than or equal to Reputation. Do not use the exploding standard skill check for this recognition test. Negative Reputation represents an actively bad reputation, but the recognition comparison for a negative value is not clarified; silently substituting an absolute value would add a rule.

When influencing someone or entering Verbal Combat, a participant can attempt a Face-Down **if the opponent knows their Reputation**. Both roll `1d10 + WILL + Reputation`. A successful participant with positive Reputation gains +3 to influencing skills relevant to that reputation. Relevance is contextual: a merciful trader and a murderous bandit do not receive identical bonuses to every skill. It is not +3 Resolve or +3 damage. The exact duration beyond the relevant confrontation is not specified.

Ridicule changes the target's Reputation **with the actual witnesses**, by −2 per successful public use, for one day (Core p. 176). Preserve base Reputation; store audience-scoped temporary reductions with source, creation, and expiry. A private exchange cannot automatically apply the public penalty. Multiple audiences may see different effective reputations at the same time.

## Timing and mixed physical combat

Core p. 151 lists initiating Verbal Combat as an action and exempts ordinary speech from taking an action unless it is Verbal Combat. The general combat round is about three seconds with initiative based on REF; Verbal Combat tools expressly use the full turn. There is no printed EMP-based social initiative formula.

The statement that Verbal Combat works much like ordinary combat does not separately enumerate every inherited action-economy detail. Document whether a social encounter follows ordinary initiative, whether extra actions (3 STA and −3) apply, whether multiple verbal defenses consume the usual extra-defense STA, and how verbal turns coexist with physical turns. Do not silently transfer Fast/Strong attacks, weapon ROF, armor, hit locations, or weapon accuracy to social exchanges.

A useful implementation boundary is an encounter record that can be linked to a Foundry Combat when the table uses combat rounds. This is an architectural recommendation, not a new printed game rule.

## Tome of Chaos integration

### Demonic negotiations and binding (pp. 140–144)

An unbound demon is not obliged to remain, and an alternative proposed bargain must appeal to its desires. A social victory must not override the explicit requirement that an unbound demon accept only a beneficial bargain. Species preferences and the actual offered service matter; do not replace them with an arbitrary universal Persuasion DC.

The Ritual of Binding creates a cage around the actual summoned named demon for 24 hours (p. 144). Verbal Combat can secure a binding agreement during that period. The demon cannot escape or attack while trapped. Only the **True Staff of Binding** can attack through the cage; the ordinary Staff of Binding is not sufficient (pp. 144, 148–149). This restriction concerns physical/magical attacks through the barrier and must not disable the very verbal exchanges the ritual requires.

Agreements made while the binding operates remain binding indefinitely unless broken. The GM makes the specified secret Resist Magic check against the original Ritual Crafting total every two weeks; a bound demon can subsequently be called without Controlled Summoning. A completed Verbal Combat receipt should supply the winner and exact agreed terms to the existing binding agreement operation. Freeform evidence currently remains a manual bridge, not proof that social combat is implemented.

Actual staff damage can establish the physical damage prerequisite for torture modifiers when the other conditions apply. A verbal attack itself must not damage the demon's HP or impersonate a staff strike.

### Reanimated corpses (p. 133)

A corpse must retain the listed anatomical structures and at least half of its brain to speak. Reanimation gives −3 Resist Coercion. Torture and Torment do not work because it is already in extreme pain. The future workflow must check restrictions on the **victim**, not merely whether the interrogator can act. The existing ritual's modifier must not be applied again as a separate social bonus.

### Trophies (pp. 124–125)

All carried trophies contribute the stated monster-slayer Reputation bonus, capped at +4, with that reputation's scope. An active magical trophy requires its normal eligibility, physical contact, one-active-trophy restriction, and one-hour change process; inventory ownership alone is insufficient.

- Botchling affects Feared standing and doubles an existing Feared bonus. The text refers to bonuses; whether any penalty also doubles should not be inferred silently.
- Succubus improves standing one step along Hated → Tolerated → Equal.
- Leshen permits Verbal Combat with animals and beasts to gain obedience, but cannot make them do something they would not do for themselves, such as jump off a cliff.

Leshen does not supply blanket universal communication with every monster or automatic obedience after an ordinary check. Preserve target classification and the stated limit on goals.

## Current implementation audit

The following describes the code at this audit, not completed social features.

| Existing code                                                | Reusable behavior                                                                                                              | Missing social behavior / integration requirement                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module/witcher/documents.js`, `config.js`                   | All required skills and their normal attributes; actor Reputation and currency; `skillBase` includes existing skill modifiers. | No Resolve pool, verbal encounter, goals, directed friendship/Romance, or audience reputation records. Human Trustworthy needs the actual opposing audience context.                                                                                        |
| `module/witcher/rules.js`                                    | Standard exploding checks, manual die-chain validation, strict numeric DC comparison.                                          | Explicit verbal opposed/tie policy and distinct damage expressions; no physical-critical inheritance.                                                                                                                                                       |
| `module/witcher/runtime.js`                                  | Check/Luck dialogs, authority requests, actor commit/rollback seams.                                                           | No attack/defense/tool exchange or Resolve damage. Physical attack budget helpers must not select weapon mechanics for verbal actions.                                                                                                                      |
| `module/witcher/authority.js`                                | GM-authoritative commands, persisted requests, permission boundaries.                                                          | Register verbal commands with encounter participants, targets, costs, and receipt validation; player client claims cannot directly set another actor's outcome.                                                                                             |
| `module/witcher/wounds.js`                                   | Existing injuries already modify relevant social skills.                                                                       | Reuse `skillBase`; do not apply the same jaw/tongue injury twice.                                                                                                                                                                                           |
| `module/witcher/magic-hex-rules.js`, `magic-effect-hooks.js` | Context-sensitive hex and ongoing magic skill changes.                                                                         | Merge normal standing with Odious Hex once; preserve audience and skill scopes.                                                                                                                                                                             |
| `module/witcher/magic-trophies.js`                           | Eligibility and trophy rule data, including standing/animal effects.                                                           | No installed social consumer for the standing and Leshen rules.                                                                                                                                                                                             |
| `module/witcher/magic-ritual-effects.js`                     | Binding cage/agreement state, reanimated corpse restrictions and −3 Resist Coercion.                                           | Replace or supplement freeform `verbalCombatEvidence` with a validated completed encounter receipt. Use a distinct verbal action category so the cage's physical attack guard does not forbid negotiation. Check corpse torture restrictions on the target. |
| `module/witcher/activities.js`                               | Existing alchemical modifiers include social skills.                                                                           | Consume the final alchemy lifecycle/modifier API after that stage; do not create a duplicate intoxication modifier store.                                                                                                                                   |
| `templates/witcher/actor.hbs`                                | Editable base Reputation and trophy display.                                                                                   | No encounter entry, Resolve display, goals, defenses, tools, relationships, or scoped temporary Reputation display.                                                                                                                                         |

No existing generic skill roll proves that the complete Verbal Combat procedure is implemented. The bindings UI presently asks the GM to record the actual completed Verbal Combat; it does not itself resolve that combat.

## Required implementation state and transaction boundaries

These are engineering requirements derived from the mechanics above, not additional game rules:

- **Encounter:** participants and sides, individual goals, audience, start time, linked combat/turn if used, selected conventions, initial/current Resolve, active/completed/disengaged state.
- **Exchange:** source actor, selected attack/tool, target snapshot, each target's defense and check, exact modifiers and die chains, damage rolls, resulting Resolve, counters, and outcome. Persist the exchange before permitting follow-up effects.
- **Scoped effects:** Seduce/Appeal/Intimidate counters, Study expiry, Imply use and defense penalty, successful bribe offer, reputation Face-Down benefit, and torture circumstances. Scope each to the applicable actor/opponent/encounter/round/audience.
- **Persistent relationships:** friendship progression and Romance/aftermath with named participants and source encounter.
- **Temporary Reputation:** public audience, amount, one-day expiry, and source exchange; never overwrite unrelated base Reputation.
- **Authority and recovery:** owner-requested checks, authoritative result/application, duplicate-click protection, stale encounter/target checks, and compensating rollback for multi-actor changes. No half-committed damage, coin transfer, friendship, or binding agreement.
- **Traceability:** cards must show check skill/attribute separately from damage attribute, target defenses, modifier sources, Resolve before/after, and any selected table convention. Tool cards with missing printed opposition must visibly record the adjudicated DC/defense.

## Decisions needed before automatic resolution

| Issue                            | What is printed                                                       | Decision that must be recorded                                                       |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Resolve rounding                 | `((WILL + INT) / 2) × 5`; derived statistics round down.              | Intermediate versus final rounding.                                                  |
| Persuade half-die                | `1d6 / 2 + EMP`.                                                      | Preserve halves or a justified explicit rounding rule.                               |
| Tied opposed defense             | Defender wins general ties; social damage says higher.                | Block only versus also defensive damage/effect.                                      |
| Romance, Imply, Bribe opposition | Skill named; no defense/DC.                                           | Adjudicated opposition for each use.                                                 |
| Cumulative riders                | Combat-limited cumulative damage; Appeal explicitly counts successes. | Success trigger, current/next hit, attacker scope.                                   |
| Group exchange                   | Every target defends and successful defenders retaliate.              | Shared/per-target damage roll and simultaneous resolution policy.                    |
| Tool scope                       | Study one round; Imply once per combat; Bribe rest of fight.          | Precise expiry, failed Imply consumption, repeat offers.                             |
| Physical timing inheritance      | Verbal combat resembles regular combat; tools take full turn.         | Initiative/extra action/extra defense costs and mixed-combat scheduling.             |
| Torture severity                 | Mild and wound-threshold modifiers listed.                            | Threshold equality and replacement versus stacking.                                  |
| Group outcomes                   | A loser accepts an opponent's argument; Disengage ends argument.      | Multiple goals/winners and participant versus group exit.                            |
| Contextual Reputation            | Relevant reputation only; Ridicule affects witnesses for one day.     | Audience representation and relevant-skill decisions; negative recognition handling. |

## Acceptance cases for the later implementation

The final system needs real document/chat/authority workflow tests in addition to pure formula tests:

1. Start and finish an argument between a PC and NPC, with independent Resolve and explicit goals, leaving HP unchanged. Initialize a second argument without destroying the first record.
2. Exercise all seven attacks and all four defenses; check Deceive, Ridicule, Ignore, and Change the Subject's different check/damage attributes.
3. Resolve one attack against several opponents with mixed results, separate defense choices, all valid return damage, consistent chosen group policy, and one idempotent final application.
4. Counter-argue with a chosen attack, including its cumulative or finishing rider under the recorded interpretation; avoid recursive defense loops.
5. Verify tied checks, fixed-DC equality, critical/fumble chains, manual dice, and the absence of weapon criticals, armor, HP injury, and spell backlash.
6. Accumulate and reset Seduce, Appeal, and Intimidate precisely once per qualifying exchange; preserve unrelated participants' counters.
7. Study expires at the agreed boundary; failed tools make no success effects. Imply enforces its one-use convention. Romance/Imply/Bribe cannot silently fabricate opposition.
8. Resolve bribe offers and an actual accepted currency transfer, with insufficient funds, duplicate requests, failed checks, and rollback.
9. Advance Befriend only on combat-finishing victories and preserve its three directed relationship levels. End a Romance badly and restrict the permanent bonus to that named romancer's empathetic attacks.
10. Apply public Ridicule to the correct witnesses, stack qualifying reductions, and expire each after one day without changing base Reputation or another audience's result.
11. Combine relevant standing, human traits, magic, alchemy, wounds, trophies, and Reputation bonuses exactly once, with visible sources and audience filtering.
12. Check actual damaged-victim torture prerequisites, the chosen wound-threshold boundary, and the reanimated corpse exception.
13. With an eligible active Leshen trophy, negotiate a permitted animal goal; reject a goal expressly beyond its stated limits.
14. Complete real Verbal Combat with a bound demon, save the winning agreement and encounter evidence, respect the 24-hour cage boundary, permit verbal actions through the cage, and preserve the separate True Staff physical-attack restriction.
15. Reject unauthorized/stale/duplicate resolutions. Fail a later write during a multi-target exchange and restore every earlier Resolve, currency, relationship, and binding change.

The implementation now records these conventions and provides the document workflows above. See [social-combat.md](social-combat.md) for the supported procedure, test coverage and remaining manual adjudication boundaries.
