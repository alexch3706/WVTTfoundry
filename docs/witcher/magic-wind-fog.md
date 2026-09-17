# Zephyr and Dormyn’s Fog

## Source and behavior

- **Core v1.35 p.103 — Zephyr:** caster-centered 2 m radius; everyone in the area is affected, including allies; no defense; 1d6 bludgeoning damage and a 6 m outward push. A collision adds ramming damage.
- **Core v1.35 p.104 — Dormyn’s Fog:** caster-centered 10 m radius; everyone inside, including caster and allies, receives −3 Awareness and a 4 m vision limit; Active, 2 STA upkeep.
- **Core v1.35 p.171 — ramming:** speed contribution is 1d6 per complete 2 m travelled, up to 5d6; target weight multiplies the speed contribution. The base ramming table describes mounts/vehicles and does not supply a human body base for magical pushes.

The existing casting, STA/Vigor, upkeep and damage-card procedures remain responsible for their own transactions. `registerWindFog()` installs the execution adapters and the GM collision command. The executor must call each world result’s `afterCommit` after actor changes, before recording completion, and call `rollback` if the transaction fails.

## Explicit table rulings

- Zephyr does not explicitly exempt its caster. The casting form records `zephyrAffectsCaster`, default unchecked. Checked means the caster takes the damage but stays at the burst origin, where no outward vector exists. This choice is visible and accepted by the authoritative GM executor; it does not remove allies from the area.
- The fog description does not state whether it moves with its caster. `followCaster` records the existing explicit choice. A following fog uses native V14 Region attachment. A stationary fog remains at its original placement.
- Identical overlapping fog Awareness penalties apply once. The source effects and their notes identify that overlap convention. Every fog remains separately tracked for later removal.
- Ramming base damage, the impacted target’s weight, and location must be resolved on the collision card. A written GM ruling is required. The dialog permits optional damage to a struck creature, also explicitly recorded as a ruling. It does not invent a horse/vehicle base for a person.
- Geometry uses native token containment, scene levels, and wall constraints. Zephyr conservatively treats same-level, same-elevation tokens as solid occupied bounds; incorporeal/overlapping geometry remains subject to the GM’s map ruling. A caster-origin push cannot infer a direction for distinct tokens whose centers exactly overlap and refuses that unresolved movement.

## Native V14 implementation

Verified against the actual v14.365 client source at `/tmp/foundry-v14-365.mjs`:

- `BaseToken` movement x/y are integer fields. Push endpoints use whole pixels toward the original position; collision is rechecked after quantization. Recorded travel and ramming speed dice use the persisted endpoint, not the intended 6 m distance. Diagonal movement can lose less than a pixel on each axis.
- Movement uses the native movement polygon backend, scene surface collision, token bounds and scene boundary checks. It sweeps in at most 0.1 m steps and refines first contact, preventing passage through narrow occupied spaces simply because the end point is clear.
- A null stored sight range becomes unlimited during Token preparation. `lightPerception` is separately added as unlimited, so changing `sight.range` alone cannot limit vision into illuminated areas. Fog caps stored sight range, light perception, and every configured `SIGHT` detection mode. Nonvisual modes such as tremor sense remain unchanged. It never grants sight or night vision to a creature that lacks them.
- Original range values, absent detection modes, and active fog Region UUIDs are persisted per token. Removing one overlapping source keeps the cap; leaving the last source restores the original state. Intervening user/module range changes establish a new baseline, and later cleanup does not overwrite a different current value.
- Native `attachment.token` moves a following Region with the caster; hidden state matches the attached token. Reconciliation runs after token/Region changes, world time, actor changes and canvas readiness. Actor penalties and token vision changes are compensated on a failed cast/reconciliation.

Linked tokens share one Actor and therefore its sheet penalties. Use distinct/synthetic Actors when multiple representations need independent Awareness values. Vision restrictions remain per token.

## Verification

`node --test tests/witcher/magic-wind-fog.test.mjs` exercises actual adapters and the registered `magicWindCollision` command using controlled persistence/dice fixtures. Cases cover source choices, native field plans, caster/allied coverage, overlap, exit/deletion cleanup, following attachment, write failures, duplicate movement, wall/token contact, whole-pixel endpoints, real damage-card generation, collision rulings and receipt failure compensation.

The fixtures do not run a Foundry server or render a real canvas. Visual confirmation of native vision, token animation, wall geometry and following Region behavior is still required in Foundry V14/The Forge.
