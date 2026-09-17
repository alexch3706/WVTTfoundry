# Spell and invocation effect procedures

`module/witcher/magic-effects.js` contains individually registered procedures for all **180 spells and invocations** in the magic catalog: 119 spells and 61 invocations. The catalog includes Core v1.35, Core Errata 2022, and A Tome of Chaos v1.01, including its two necromantic spells.

This registry is an executable **planning layer**. A registered plan is not a declaration that every part has a Foundry executor. The casting runtime must check its supported operations, actions, rules, recurring events, and special parameters before offering an automated cast.

## Runtime status

At the 2026-09-17 working-tree checkpoint, **54 of these 180 spell/invocation entries** are in `IMPLEMENTED_MAGIC`: 34 spells and 20 invocations. The other 126 remain references with casting disabled. There are also 12 enabled signs in a separate implementation. Rituals and hexes use their own procedure engine and are outside the 180-plan count. See the [implementation inventory and gaps](magic-progress.md).

Runtime acceptance requires separate checks:

1. `magic-support.js`/`magic-state.js` permit the key. A plan or adapter does not add a key to this list.
2. Targeting and choice validation check actual targets, required table rulings and owned objects.
3. `preflightSpell`/`basicOperationSupported` require the chosen mode’s complete operation semantics before costs. Specialized healing/counter/sign procedures have explicit dispatch and validation.
4. The authoritative command performs real checks, resource and document changes. Persistent operations retain receipts; adapters return compensation. `afterCommit` reconciles world changes after actor writes, before the final receipt.
5. Pending defenses, damage applications and actionable GM decisions stay visible; successful casting does not establish that all later effects are resolved.

Connected executors include immediate effects, selected item/information changes, repeated defenses/attacks, native Regions, Talfryn’s roots, Adenydd’s glide, Zephyr’s collision movement, Dormyn’s native vision and distinct HP/wound/rest healing. They do **not** certify every operation of those types. Zephyr’s push does not implement Hand of the Tempest’s launch/manipulation modes; a transformation plan does not implement Polymorphism.

## Contract

```js
const plan = spellEffectPlan('water-jet', {
  castTotal: 24,
  power: 5,
  choices: { damageType: 'piercing', waterSource: 'Scene.scene.Region.river' },
  rolls: {},
});
```

A plan contains `key`, `source`, `page`, `duration`, `ready`, `requirements`, `operations`, `adjudications`, `requiredExecutorKinds`, `ongoingTriggers`, and `notes`.

Missing input produces `ready: false`, typed `requirements`, and **no operations**. Collect those inputs, obtain authoritative rolls, and build again. Do not debit resources or apply part of an incomplete effect.

`requiredChoices(key)` returns descriptors for enum, numeric, text, boolean, actor, item, effect, and point inputs. Conditional fields use `when`; material restrictions such as an actual metal item, a visited destination, or a local source of water must be checked against authoritative documents by the runtime. A string identifier by itself is not proof of eligibility.

Context values such as `defenseTotal`, `spellCastingRank`, `spellCastingBase`, `targetVigor`, and `originalSTA` come from the authoritative actor or saved casting message. They must not be accepted from an untrusted player request. `rolls` holds actual rolled totals, including duration and one-time random values.

`supportProfiles()` advertises required executor kinds, named persistent rules, document actions, recurring events, and choices. `keysForExecutorKinds(kinds, {rules, actions, triggers})` requires every advertised capability. It deliberately does not accept a broad `modifier` executor as proof that healing suppression, invisibility, or a custom terrain rule works. These capability lists are a necessary gate; individual field semantics still require executor validation.

## Operations

Every operation carries a `type`, `target`, and `timing`; top-level operations receive the resolved duration. Nested operations inherit their enclosing lifetime unless overridden.

| Type           | Responsibility                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `damage`       | Roll the specified formula, use the selected body location and defenses, respect armor/shield instructions, and permit physical criticals only when declared. |
| `heal`         | Restore HP at the stated time, clamped to maximum; obey healing suppression.                                                                                  |
| `condition`    | Add/remove a named system condition, resolving any chance or save. Preserve independent causes and overlapping spell sources.                                 |
| `modifier`     | Apply numeric modifiers or execute a specifically named persistent rule. Predicates and restrictions are part of that rule.                                   |
| `resource`     | Alter STA, HP, LUCK, or a named temporary pool, respecting its mode and expiration.                                                                           |
| `move`         | Resolve forced movement, collisions, falling, portals, or manipulation using scene geometry.                                                                  |
| `shield`       | Create a barrier, restraint, or cover with its specific HP/SP, traversal rules, and escape procedure.                                                         |
| `zone`         | Create a region and execute its nested effects on precisely the specified events.                                                                             |
| `summon`       | Create the stated creature or spell entity with its controller, statistics, abilities, lifetime, and limits.                                                  |
| `transform`    | Save the original form, apply the stated form rules, and restore it with the spell’s injury/damage transfer rules.                                            |
| `dispel`       | Remove, counter, redirect, or offer repeated defenses against the indicated magic.                                                                            |
| `restoreWound` | Perform the exact injury operation: treatment use, healing, permanent restoration, temporary wound effects, or dismemberment.                                 |
| `item`         | Perform a specific equipment, crafting, cover, alarm, material, or consumable operation.                                                                      |
| `reveal`       | Reveal only the information authorized by that spell to the appropriate participants.                                                                         |
| `narrative`    | Request the explicit GM decision identified by `procedure`; this remains pending until decided.                                                               |

`flattenOperations()` includes nested attacks, on-hit effects, save failures, trap effects, portal closure effects, and active actions. It does not flatten a multi-stage effect into a single unconditional application.

## Source decisions and unresolved text

- **Blessing of Love, Core p.111:** the effect names the caster as beneficiary, while its Range line says 5m. The plan applies its bonuses to the caster and preserves the printed range in the catalog.
- **Seirff Haul, Core p.106:** the Duration line is `2d10` without a unit. The GM supplies the actual round count; the system does not silently assume a unit.
- **Stammelford’s Earthquake, Core p.105:** neither the recurring Athletics DC nor the shape of its “10m area” is specified. Both require a recorded GM choice.
- **Demetia’s Crest Surge, Core p.106:** Range is 10m but the shield’s own radius is not defined separately. Region size requires a table decision.
- **Magic Screen, Tome p.82:** Duration says Immediate, while the effect expressly remains until dispelled or an item leaves the cube. The procedure follows the explicit persistent-effect condition.
- **Invisible Ribbon and Touch of Lightning, Tome p.87:** the book names Perception, while the system skill list contains Awareness. The GM selects Awareness or a custom Perception skill.
- **Retribution of the Raven, Tome p.95:** the range is 20m without an explicit radius label. Region radius requires a GM choice.
- **Cones:** an angle absent from the book remains a table setting. Breath of Fire is a single-target spell with 4m range, not a cone.
- **Hex range/defense:** outside this registry; do not derive missing hex rules from these spell procedures.
- **Zephyr, Core p.103:** caster exemption is not explicit. `zephyrAffectsCaster` records the table’s choice; allies remain affected. Included caster damage does not invent displacement from the burst origin.
- **Dormyn’s Fog, Core p.104:** `followCaster` records a stationary or following native Region. Everyone inside receives the printed Awareness and vision limits. See [wind/fog](magic-wind-fog.md).

## Runtime risks that need dedicated verification

1. **Partial success and transactional changes.** A blocked attack, failed save, delayed area hit, or player cancellation must not create half a summon, duplicate a resource debit, or leave temporary modifiers behind. Compensate actor, item, token, region, and chat writes together.
2. **Defense timing.** Mental Command’s +5 defense exception and Quill of the Divine’s implantation exception apply before opposed defense resolves. A plan containing those parameters does not retroactively fix an already resolved roll.
3. **Damage stages.** A chance “on hit” and an effect only after armor penetration are different. Tryferi Gaeaf attaches ice only on penetration. Carys’ Hail remains one attack despite multiple damage dice. Each Tryferi spike is a separate attack.
4. **Repeated and conditional events.** Entering a region, starting a turn, crossing it during forced movement, and the region moving onto a token are separate triggers. Blaze of the Korath drains on specified own-turn entry; a generic enter hook is insufficient.
5. **Overlapping effects.** Removing one blinded, poisoned, grappled, or magically protected effect must preserve unrelated causes. Maximum-HP buffs must not repeatedly grant their HP upon entering and leaving the same zone.
6. **Derived statistics.** Light Feet’s SPD, Run, and Leap increases cannot be applied both directly and through recomputation. Temporary BODY/INT or maximum-resource effects must use one consistent recalculation path.
7. **Summons and transformations.** Controller permissions, copied embedded Items, synthetic actors, form expiration, permanent bonded crows, hostile wraiths, and transferable wounds require real document tests. Great Bear form has a special 1 HP floor when reverting from otherwise lethal damage.
8. **Equipment identity.** Once-per-dose copying, one-time cover reinforcement, component recovery, temporary Focus suppression, rust, and material conversion must reference concrete owned Items or scene cover documents. Description-only flags do not perform those changes.
9. **Information.** Divination, telepathy, illusions, and compelled answers require a GM response when the fact is not represented in documents. Announcing a spell’s prose does not reveal the answer. Keep hidden information in private messages.
10. **Permanent consequences.** Healing Rest heals treated wounds but preserves permanent injury penalties. Miracle of Lebioda can remove a permanent wound and regrow anatomy. Temporary Concussion from Ball Lightning uses `difficult-4` and expires after ten minutes.

## Verification

`tests/witcher/magic-effects.test.mjs` exercises all 180 registered plans and source-specific exceptions: margin damage, Carys’ single attack, critical treatment without HP healing, permanent wound restoration, constrained choices, movement, ice penetration, Concussion identity, eight terrain modes, strict capability gating, ambiguous source rulings, hostile necromancy, and transformation damage transfer.

Those are planning tests. Runtime evidence comes from separate casting, ongoing, restraint, movement, healing, wind/fog, world-effect and procedure workflows. They execute registered handlers and document changes through controlled persistence interfaces; actual V14 client inspection/model cleaning supplements them. A passing plan test is not live Forge acceptance or proof that its catalog entry is enabled.
