# Foundry VTT Manual Testing Guide: Single-Shot Firearm Resolution

This guide outlines the step-by-step verification process for the Corebook Fidelity single-shot combat resolver path in **Foundry VTT**. Use this document to manually audit UI/UX flows, sheet updates, and chat log output.

---

## 1. Environment & Setup

Ensure the system is loaded in a clean test world, and the following components are available on the active scene:

### 1.1 Attacker Setup
1. Create a new Actor named **Solo (Attacker)**.
2. Open the actor sheet and navigate to the **Combat** tab.
3. Add a Ranged Weapon:
   - **Name**: Heavy Pistol
   - **Damage**: `4d6`
   - **Shots**: `10` / `10`
   - **RoF**: `2`
   - **Reliability**: `standard`
   - **Range**: `50`m
   - **Accuracy**: `0`
4. Set attacker stats:
   - **REF**: `8`
   - **Handgun Skill**: `6`

### 1.2 Target Setup
1. Create a new Actor named **Target (Defender)**.
2. Open the actor sheet, navigate to **Gear**, and add an Armor item:
   - **Name**: Kevlar Vest
   - **Equipped**: Yes
   - **SP (Torso)**: `12`
3. Set defender stats:
   - **BODY**: `6` (BTM: `-2`)
4. Create a token on the active scene for both the Attacker and the Target.

---

## 2. Standard Attack Flow (Confirm Path)

Verify that a standard single-shot ranged attack resolves, prompts preview confirmation, mutates stats on confirm, and updates the chat card in-place.

### 2.1 Target Selection
1. Select the **Solo (Attacker)** token.
2. Use Foundry's Target tool (or double right-click / Alt+click depending on config) to target the **Target (Defender)** token on the scene.
3. Verify that the targeting reticle is visible on the Target token.

### 2.2 Initiating the Roll
1. Open the **Solo (Attacker)** actor sheet.
2. In the **Combat** tab, find the **Heavy Pistol** and click the roll button (dice icon).
3. The Ranged Attack Modifier Dialog should appear:
   - Select **Semi-Auto** or **Single Shot** fire mode.
   - Select the target range (e.g., **Medium**).
   - Leave other modifiers default or specify aim rounds if desired.
   - Click **Roll**.

### 2.3 Preview Dialog Validation
1. An in-progress combat preview dialog should appear on screen.
2. Confirm the displayed values in the dialog:
   - **Attacker**: "Solo" using "Heavy Pistol"
   - **Target**: "Target"
   - **Attack roll**: Verify the total (1d10 + REF 8 + Handgun 6 + Accuracy) against the Target Number (Medium DC: 20).
   - **Hit/Miss status**: Confirm it correctly identifies a **Hit** if the total is >= 20, or **Miss** if < 20.
   - **Ammo change**: Displays `-1` spent (Shots: `9 / 10`).
   - **Wound Transition & Damage**: Summarizes final damage (if hit) taking into account Kevlar Vest SP (12) and BTM (-2). *Note: This calculation assumes the hit lands on the Torso (either rolled randomly or aimed); hits to unarmored body locations will not apply the Kevlar Vest's SP.*
   - **Warnings**: Ensure no unexpected warnings are displayed.

### 2.4 Committing the Outcome
1. Click **Confirm** on the preview dialog.
2. **Verify Sheet Mutations (Database changes)**:
   - Open **Solo (Attacker)** sheet: verify ammo is decremented by 1 (Shots Left: `9`).
   - Open **Target (Defender)** sheet (if a hit occurred and damage penetrated SP): verify damage is increased by final damage value, and Kevlar Vest SP on Torso is ablated by 1 (SP: `11`). *Note: In Cyberpunk 2020, armor is only ablated if the damage exceeds the stopping power (damage > SP). If damage <= SP, no damage is taken and armor SP is not ablated.*
3. **Verify Chat Card**:
   - Locate the generated chat card in the Foundry chat log.
   - Confirm the banner status displays **[COMMITTED] - Applied to Actor(s)** in a green border.
   - Confirm no duplicate chat cards were created (only one card exists for this attack).

---

## 3. Standard Attack Flow (Cancel Path)

Verify that canceling a roll updates the chat card status in-place and leaves database stats untouched.

### 3.1 Flow Execution
1. Ensure the attacker has targets selected and initiate a weapon roll as in Section 2.
2. When the preview dialog appears, inspect the values, then click **Cancel**.

### 3.2 Verification
1. **Verify Sheet State**:
   - Open Attacker sheet: Ammo must **not** be decremented (remains at the pre-attack count).
   - Open Target sheet: Damage and armor SP must **not** be mutated.
2. **Verify Chat Card**:
   - Locate the chat card in the log.
   - Confirm the banner status is updated in-place to **[CANCELED] - Discarded** in a red border.
   - Confirm no database changes were applied.

## 3.3 Concurrency Race Checks (Story 7.4)

1. Run a normal preview and rapidly click **Confirm** twice (or press Enter repeatedly if confirm is focused).
2. Verify only one state commit happens:
   - Attacker ammo decrements exactly once.
   - Target damage and armor ablation update exactly once.
   - Chat card does not show duplicate mutation effects.
3. Open two overlapping previews that would mutate the same attacker ammo and target actor/armor state.
4. Confirm the first preview, then confirm the older second preview.
5. Verify the second confirm is blocked/manualized with a stale-state warning and does not overwrite newer values.

---

## 4. Manual Resolution Fallbacks

Verify that missing actor context or state conflicts block the commit path and alert the referee.

### 4.1 Missing Target Actor Context
1. Place a token on the scene that is **not** linked to any Actor (e.g., an actorless token template).
2. Select the Attacker and target this actorless token.
3. Initiate an attack.
4. Verify the preview Dialog pops up and:
   - Displays a warning banner: **Target Actor is unavailable; resolve target damage, armor, and saves manually.**
   - Disables the **Confirm** action, forcing manual GM resolution.
5. Click **GM Resolution** (or the corresponding manual confirmation button). *Note: Only users with Gamemaster (GM) permissions in Foundry VTT will see or be allowed to resolve this fallback path.*
6. Verify the chat card updates in-place to **[MANUAL] - Requires GM Resolution** in a yellow/orange banner.
7. Open the Target (Defender) sheet and manually apply the damage to the Wound Tracker and decrement armor SP (if appropriate) according to the GM's manual calculations.

### 4.2 Insufficient Ammo Warning
1. Set the Attacker's weapon ammo count to `0` on the actor sheet.
2. Target the Defender and initiate a roll.
3. Verify the preview dialog displays a warning: **Insufficient ammo to perform attack.**
4. Confirm the commit action is blocked or marked for manual resolution.

---

## 5. Running Automated Fixtures

To execute the automated suite of deterministic combat fixtures (verifying normalization, outcomes, hit locations, and fallbacks in code):
1. Open a terminal in the project root directory.
2. Run the command: `node tests/run-combat-fixtures.mjs`.
3. Verify that the output ends with `155 fixture(s): 155 passed, 0 failed`.

---

## 6. Epic 3 Damage Pipeline & Save Resolution (Manual Checks)

Verify that the core combat resolver faithfully applies the Cyberpunk 2020 damage pipeline rules, including armor penetration, layering, cover, head/limb criticals, BTM minimums, and save prompts.

### 6.1 Armor Piercing (AP) & Staged Penetration
1. Set up an Attacker with an AP weapon (e.g., Heavy Pistol with AP enabled in item snapshot: `weapon.snapshot.ap = true`).
2. Target a Defender with **Kevlar Vest (SP 12)** on the Torso.
3. Roll a hit:
   - In the preview dialog, verify that the effective stopping power is halved to **6**.
   - If raw damage is 8 (higher than effective SP 6), final damage penetrates.
   - Verify that confirming the hit ablates the Kevlar Vest by 1 (SP becomes **11** on the actor sheet).
4. If staged penetration is disabled (e.g., config/option `stagedPenetration: false`):
   - Verify that the Kevlar Vest SP is **not** ablated on the actor sheet upon confirmation.

### 6.2 Armor Layering & Cover
1. Equip the Defender with multiple armor layers (e.g., **Skinweave SP 8** and **Kevlar Vest SP 12**).
2. Set up a Ranged Attack option with cover (e.g., **Concrete Barrier SP 10**).
3. Verify the effective stopping power calculation:
   - Cover resolves as a separate first stage (Concrete Barrier, SP 10).
   - Only remaining damage is evaluated against personal armor (equipped armor/cyberware proportional layering).
4. Roll a hit:
   - If damage penetrates cover but does not penetrate personal armor, confirm staged penetration evidence includes `penetrated-manual-cover` and no embedded item update is planned.
   - If damage penetrates both cover and personal armor, confirm cover ablation evidence is present and exactly one item-backed personal layer is ablated.
   - If the penetrated personal layer is actor-owned Skinweave/Subdermal cyberware, confirm staged penetration evidence includes `updatePath: "system.ablation"` and the embedded item update targets that cyberware item `_id`.
   - If cover fully stops damage, confirm no personal armor ablation is planned.
5. Confirm the preview and chat evidence line up with persistence:
   - Confirm the attack.
   - Open the penetrated Skinweave/Subdermal item on the defender and verify `system.ablation` increased by 1.
   - Repeat a second hit in the same attack flow where applicable and verify effective cyberware SP is reduced by the prior staged ablation.

### 6.3 Body Type Mitigation (BTM) & Minimum Damage
1. Set Defender stats: **BODY 6** (BTM: `-2`).
2. Roll a hit that results in **3** penetrating damage (after armor SP subtraction):
   - Verify that the preview dialog applies BTM `-2` and lists the final damage as **1** (`3 - 2 = 1`).
3. Roll a hit that results in **1** penetrating damage:
   - Verify that the preview dialog lists the final damage as **1** (minimum damage rule applies instead of reducing it to `-1` or `0`).

### 6.4 Head Hits & Limb Damage Thresholds
1. Roll a hit to the **Head**:
   - Verify that the final damage is doubled in the preview dialog.
   - If the final damage exceeds 8 (e.g., 5 base x 2 = 10), verify that the preview displays a warning: **"Head hit exceeded 8 damage... target is killed automatically..."**.
2. Roll a hit to a **Limb** (Arm/Leg):
   - If the final damage exceeds 8, verify that the preview displays a warning: **"Limb hit exceeded 8 damage... limb is severed or crushed..."**.

### 6.5 Stun/Shock & Death Save Prompts
1. Roll an attack that inflicts damage, putting the target into a **Serious** or **Critical** wound state (damage <= 12):
   - Verify that the preview lists a pending **Stun Save** prompt.
   - Verify the save threshold/target number incorporates the wound penalty (Serious: `-1`, Critical: `-2`).
2. Roll an attack that puts the target into a **Mortal** wound state (damage >= 13):
   - Verify that the preview lists both a pending **Stun Save** (penalty `-3`) and a pending **Death Save** (penalty `0`).
3. Target an already **Mortal** defender and roll a stopped hit (0 damage):
   - Verify that the preview does **not** list an attack-time recurring Death Save reminder.
4. Put a Mortal defender into an active Combat encounter and advance to that combatant's turn as GM:
   - Verify that exactly one turn-start **Death Save Reminder** chat message appears.
   - Verify that the reminder identifies the actor, Mortal level, Body Type, penalty, and threshold.
   - Verify that refreshing or advancing on a non-GM client does not duplicate the reminder.
5. Mark or represent the defender as stabilized/dead where supported, or set damage to Mortal 7+:
   - Verify turn-start reminders are suppressed and Mortal 7+ damage surfaces as dead/manual state rather than a new Death Save prompt.
6. Verify that confirming attack states persists the damage updates on the target sheet, and pending attack-time saves are printed to the chat card for player/GM resolution.

---

## 7. Epic 4 Automatic Fire (Manual Checks)

Verify that three-round burst, full auto (single and multi-target), suppressive fire, and jam/reliability behavior in automatic fire modes produce correct preview/confirm flows, ammo accounting, hit count/damage, and chat evidence.

### 7.1 Environment Setup
Create a clean Foundry test world with:
- **Attacker**: Create a character named **Solo (Attacker)** with:
  - **REF**: `8`, **Rifle Skill**: `6`
  - **Assault Rifle** (auto weapon): Damage `4d6`, Shots `30` / `30`, RoF `30`, Standard reliability, Range `400`m, Accuracy `0`
  - **Backup Very Reliable weapon**: Copy the assault rifle, set reliability to `"VeryReliable"`
  - **Backup Semi-Auto weapon**: A pistol with handgun skill (for Section 7.7 semi-auto check)
- **Targets**: Three NPC actors named **Target A**, **Target B**, **Target C**, each with:
  - **BODY**: `6` (BTM: `-2`)
  - **Kevlar Vest**: SP `12` on Torso, equipped
  - Place all tokens on an active scene

### 7.2 Three-Round Burst
1. Target **Target A** with Foundry's targeting tool.
2. Open Solo's sheet → Combat tab → click the Assault Rifle roll button.
3. In the modifiers dialog, select **Three-Round Burst** fire mode at **Medium** range, click Roll.
4. ✅ Fire mode dropdown shows **"Three-Round Burst"** (not hidden, not disabled).
5. ✅ Preview dialog shows **3 rounds expended**, ammo: `30 - 3 = 27`, hit count based on burst roll (1d3) capped by margin.
6. ✅ Preview shows a `[COMMITTED]` button and a `[CANCEL]` button.
7. Click **Confirm**:
   - ✅ Chat card updates to `[COMMITTED]` banner (green).
   - ✅ Chat card displays burst hit count, ammo delta `-3`, damage per hit with location/armor/penetration.
   - ✅ Attacker sheet ammo shows `27`.
8. Repeat with weapon set to **1 round left**:
   - ✅ Preview shows **1 round expended**, burst_hits capped at 1, ammo: `1 - 1 = 0`.
9. Try attacking with **0 rounds**:
   - ✅ Preview shows insuffient ammo warning, `[CONFIRM]` is blocked or marked manual.

### 7.3 Full Auto, Single Target
1. Reload weapon to 30 shots. Target **Target B**.
2. Select **Full Auto** fire mode, **Close** range, click Roll.
3. ✅ Preview dialog shows ammo delta = `30` (min(shotsLeft=30, ROF=30) = 30).
4. ✅ Hit count = `Math.min(roundsFired, margin)` capped at rounds fired.
5. ✅ Chat card shows full auto details, hit locations, damage per hit, ammo delta `-30`.
6. ✅ Confirm: attacker ammo = `0`.
7. Reload to 30 shots, select **Long** range:
   - ✅ Preview shows single hit with full auto `-3` modifier (`-1 * Math.floor(30/10)`).
8. Select **Medium** range with 10 shots:
   - ✅ Preview shows ammo delta = 10, full auto `-1` modifier (`-1 * Math.floor(10/10)`).

### 7.4 Full Auto, Multi-Target
1. Reload weapon to 30 shots. Target **Target B** and **Target C** (2 targets).
2. Select **Full Auto**, **Close** range, click Roll.
3. ✅ Preview dialog shows per-target outcomes:
   - Rounds per target = `Math.floor(30 / 2) = 15`.
   - Ammo delta = `30`.
4. ✅ Chat card shows each target's outcomes with separate hit/miss, locations, damage.
5. On confirm:
   - ✅ Attacker ammo = `0`.
   - ✅ Each target's damage/armor updated per hit count.
6. Target all three NPCs, reload weapon to 25 shots:
   - ✅ Rounds per target = `Math.floor(25 / 3) = 8`, ammo delta = `24` (1 round left over).
   - ✅ Third target rounds fire normally.

### 7.5 Suppressive Fire — Hidden When Fidelity ON
1. Ensure **Corebook Fidelity Mode** setting is **ON** (default).
2. Open Solo's sheet, select Assault Rifle, open modifiers dialog.
3. ✅ **"Suppressive"** is **NOT** visible in the fire mode dropdown.
4. ✅ Only Semi-Auto, Three-Round Burst, and Full Auto are visible.

### 7.6 Suppressive Fire — Warning When Fidelity OFF
1. Open World Settings → toggle **Corebook Fidelity Mode** to **OFF**.
2. Target any NPC, select **Suppressive** fire mode, any range, click Roll.
3. ✅ A warning notification appears: **"Suppressive fire not supported without zone width and rounds fired inputs."**
4. ✅ Chat card shows manual-resolution status (`[MANUAL]`), no hits applied, no ammo deducted.
5. Reset Corebook Fidelity Mode to **ON**.

### 7.7 Jam and Reliability
1. Ensure attacker has a **Standard reliability** auto weapon with full ammo (30 shots).
2. Target an NPC, roll full auto attacks repeatedly until a **natural 1** occurs on the attack d10.
3. ✅ On natural 1 with Standard reliability:
   - Chat card shows jam warning (`isJam: true`), hit forced false.
   - Ammo **is** deducted (full ROF).
   - `[PENDING DECISION]` jam indicator visible in chat card.
4. Switch to a **Very Reliable** weapon (edit item or create one).
5. Roll until natural 1:
   - ✅ On natural 1, no jam warning, just a miss (`hit: false`, no `isJam`).
   - Ammo **is** deducted.
6. Load a **semi-auto** weapon (non-automatic).
7. Roll until natural 1:
   - ✅ No jam, standard fumble miss only (no `isJam` on roll).

### 7.8 Ammo Consistency
1. Set weapon to exactly **5 rounds** remaining.
2. Full auto at Close range (ROF ≥ 10).
3. ✅ Preview shows ammo delta = **5** (not ROF — bounded by `shotsLeft`).
4. Confirm, verify ammo = **0**, no negative values.
5. Try another attack with **0 ammo**:
   - ✅ Preview shows ammo warning, commit is blocked or marked manual.
6. Set weapon to **1 round**, select **Three-Round Burst**:
   - ✅ Preview shows **1 round** expended (`Math.min(1, 3) = 1`).
7. Set weapon to **2 rounds**, select **Three-Round Burst**:
   - ✅ Preview shows **2 rounds** expended (`Math.min(2, 3) = 2`).

---

## 8. Epic 5 Melee & Martial Actions (Manual Checks)

Verify that melee attacks resolve as opposed rolls, martial actions use correct categories and key technique bonuses, grapple-family prerequisites are enforced, and chat evidence displays correct action labels.

### 8.1 Environment Setup
Create a clean Foundry test world with:
- **Attacker**: Create a character named **Fighter (Attacker)** with:
  - **REF**: `9`, **Melee**: `5`, **Brawling**: `6`, **Karate**: `5`, **Aikido**: `5`
  - **Melee Weapon**: Knife (damage `1d6`, attackSkill `melee`)
  - **Martial Weapon**: Fists (damage `1d3`, attackType `Martial`, attackSkill `null`)
  - **BODY**: `6` (BTM: `-2`)
- **Defender**: Create an NPC named **Guard (Defender)** with:
  - **REF**: `6`, **Brawling**: `3`, **Melee**: `4`
  - **BODY**: `8` (BTM: `-2`)
  - **Light Armorjack**: SP `4` on Torso, equipped
- Place tokens for both actors on an active scene.

### 8.2 Basic Melee Attack
1. Select the **Fighter** token. Target the **Guard** token.
2. Open Fighter's sheet → **Combat** tab → click a **melee weapon roll** button (e.g., Knife).
3. A melee roll should fire — there is **no modifiers dialog** for melee (melee rolls begin resolution immediately).
4. ✅ A preview dialog appears showing:
   - **Attacker**: Fighter using Knife
   - **Opposed Roll**: Attacker REF `9` + Melee `5` + 1d10 vs Defender REF `6` + Melee `4` + 1d10
   - **Hit/Miss**: Hit when attacker total > defender total
   - **Damage**: Weapon damage (1d6) + strength bonus from attacker BODY (6 → +0) — armor/BTM applied
   - **Ammo**: No ammo change (melee)
5. Click **Confirm**:
   - ✅ Chat card updates to `[COMMITTED]` banner (green)
   - ✅ Chat card shows opposed roll values with attacker/defender totals
   - ✅ Damage displays raw damage, armor mitigation, BTM, final damage
   - ✅ Defender sheet damage is updated
6. Click **Cancel** on a subsequent roll:
   - ✅ Chat card updates to `[CANCELED]` banner
   - ✅ No sheet mutations applied

### 8.3 Melee — Defender Wins
1. Attack again. If defender roll > attacker roll:
   - ✅ Preview shows **miss** (`hit: false`)
   - ✅ No damage section displayed
   - ✅ Ammo unchanged
2. Confirm the miss:
   - ✅ Chat card shows `[COMMITTED]` with miss status
   - ✅ "Defender wins" information visible in roll evidence

### 8.4 Martial Action — Strike with Karate
1. Ensure Fighter has **Karate 5** skill and the martial weapon (fists). Target the Guard.
2. Open Fighter's sheet → find the martial action control (dropdown or selector).
3. Select **Strike** action → **Karate** style.
4. Click roll:
   - ✅ Preview dialog shows **martialCategory: "damageOnly"**
   - ✅ Attack total includes **key technique bonus +2** (Karate strike)
   - ✅ Opposed roll uses attacker Karate vs defender Brawling
   - ✅ Damage resolves (1d3 + strength bonus — armor — BTM)
5. Confirm:
   - ✅ Chat card shows `[COMMITTED]`, action label "Strike", style "Karate", bonus "+2"
   - ✅ Sheet mutations applied
   - ✅ Chat card shows martialCategory "damageOnly" in the roll evidence

### 8.5 Martial Action — Block/Parry (Non-Damage)
1. Select **Block/Parry** action → **Karate** style.
2. Click roll:
   - ✅ Preview shows martialCategory: **"nonDamage"**
   - ✅ Attack total includes key technique bonus **+1** (Karate block/parry)
   - ✅ **hits is empty** — no damage section
   - ✅ No ammo, no damage planning
3. Confirm:
   - ✅ Chat card shows `[COMMITTED]` with Block/Parry result
   - ✅ Chat card shows martialCategory "nonDamage" in the roll evidence
   - ✅ No sheet mutations (no damage, no ammo)

### 8.6 Martial Action — Kick with Savate
1. Select **Kick** action → **Savate** style.
2. Click roll:
   - ✅ Preview shows martialCategory: **"damageOnly"**
   - ✅ Attack total includes **key technique bonus +2** (Savate kick)
   - ✅ Opposed roll uses attacker Savate vs defender Brawling
   - ✅ Damage resolves (1d3 + strength bonus — armor — BTM)
3. Confirm:
   - ✅ Chat card shows `[COMMITTED]`, action label "Kick", style "Savate", bonus "+2"
   - ✅ Chat card shows martialCategory "damageOnly" in the roll evidence
   - ✅ Sheet mutations applied

### 8.7 Martial Action — Grapple (No Prerequisites)
1. Select **Grapple** action → **Karate** style.
2. Click roll:
   - ✅ Preview shows martialCategory: **"grappleFamily"**
   - ✅ Attack total includes key technique bonus **+0** (Karate grapple not a key technique)
   - ✅ **hits is empty**
   - ✅ No pending decisions, no manual resolution
3. Confirm:
   - ✅ Chat card shows `[COMMITTED]` with Grapple outcome
   - ✅ Chat card shows martialCategory "grappleFamily" in the roll evidence

### 8.8 Martial Action — Choke with Prerequisite Confirmed
1. First set up defender with the prerequisite hold state by running this in the browser console:
   ```js
   game.actors.getName('Guard (Defender)').update({
     'system.combatState.held': true
   });
   ```
2. Then switch to the attacker, select **Choke** action → **Aikido** style.
3. Click roll:
   - ✅ Preview shows martialCategory: **"grappleFamily"**
   - ✅ Attack total includes **key technique bonus +0** (no key technique for choke)
   - ✅ **hits is empty** — grappleFamily
   - ✅ No manual resolution (prerequisite confirmed via combatState)
4. Confirm:
   - ✅ Chat card shows `[COMMITTED]` with Choke outcome
   - ✅ Chat card shows martialCategory "grappleFamily" in the roll evidence

### 8.9 Martial Action — Hold with Prerequisite Confirmed
1. Switch to **Aikido** style. Select **Hold** → roll (Hold requires grapple — will be blocked).
   - ✅ Preview shows `[MANUAL]` banner with "prerequisite-unconfirmed" reason
   - ✅ Confirm button disabled or blocked
   - `[GM override or manual resolution flow]`
2. To test a clean path with prerequisite already satisfied, run this in the browser console before rolling:
   ```js
   // Set combatState.grappled on the defender token's actor
   game.actors.getName('Guard (Defender)').update({
     'system.combatState.grappled': true
   });
   ```
   Then select **Hold** → **Aikido** → roll
   - ✅ Preview shows clean outcome, no manual resolution
   - ✅ Hit/miss based on opposed roll
   - ✅ hits is empty (grappleFamily)
   - ✅ Chat card shows martialCategory "grappleFamily" in the roll evidence

### 8.10 Martial Action — Disarm (Prerequisite Warning, No Block)
1. Select **Disarm** action → **Aikido** style.
2. Click roll:
   - ✅ Preview shows martialCategory: **"nonDamage"**
   - ✅ Attack total includes key technique bonus **+1**
   - ✅ **hits is empty**
   - ✅ Chat card shows a **prerequisite warning** ("Disarm requires Block/Parry or Dodge")
   - ✅ **Confirm button IS available** — disarm is non-grappleFamily, so the warning is advisory
3. Confirm:
   - ✅ Chat card updates to `[COMMITTED]` with pending decision warning
   - ✅ Chat card shows martialCategory "nonDamage" in the roll evidence
   - ✅ No sheet mutations

### 8.11 Default Melee with Martial Art Not Matching Weapon Skill
1. Use the **Knife** (melee weapon, attackSkill: "melee") while having **Karate 5**.
2. Select a martial action → **Strike** → **Karate**:
   - ✅ Resolver uses Karate skill for opposed roll (not melee skill)
   - ✅ Key technique bonus applies
   - ✅ Chat card shows martialCategory "damageOnly" in the roll evidence
   - Damage resolves through martial damage pipeline.

### 8.12 Manual Resolution — Missing Defender Context
1. Place an actorless (unlinked) token on the scene.
2. Target the actorless token, initiate a melee attack:
   - ✅ Preview shows `[MANUAL]` banner with "missing-target-actor" reason
   - ✅ Confirm button is blocked
   - ✅ Chat card shows manual-resolution status
