# Attack and save controls

The manual **Stun/Death Save** button rolls one ordinary d10 and displays each
applicable result separately. Success means **d10 ≤ threshold**, including
equality. It shares the combat resolver's thresholds and does not inherit attack
critical/fumble colors. Before Mortal wounds, or while stabilized, Death is
shown as not required. This informational button does not change conditions or
mark outstanding chat-save prompts as resolved.

## Attack form

An ordinary attack now starts with one form: weapon and selected targets,
fire mode, range, aiming and hit location. Situational modifiers, cover SP,
target count and the extra modifier are in **Advanced**. A melee attack retains
its applicable action/style controls. The last valid fire mode is remembered for
that weapon during the current client session; range, aim, situational modifiers
and physical dice are not reused for a new attack.

For shotgun/area attacks, choose **Selected targets** or **Place area template**
inside this form. Template placement happens after submission and distances are
measured for each affected target. Suppressive fire appears only when the form
can configure its corridor; it opens corridor settings only after that mode is
selected. Autoshotgun full-auto retains its shell-count and pattern placement.

If the existing physical-die setting is enabled, enter the d10 in the attack
form itself. Blank means automatic; `10,7` means a natural ten plus one follow-up
roll. Invalid input and canceled placement leave the form open for correction.
Submitting twice while an attack is running does not resolve it twice.

Persistent suppressive corridors stay inactive until ammunition is charged.
Canceled previews spend nothing; recoverable write failures remove the pending
zone and restore a confirmed debit. If rollback or ammunition state cannot be
verified, the form blocks retry and asks the GM to reconcile the named zone and
ammunition instead of creating another hazard.

The normal path remains **attack form → roll → review/apply**. The final review
of ammunition, wounds and armor changes is deliberately retained by default.
Actual obstructions still require a cover decision; this change does not guess
cover SP or skip those decisions.

## Manual Foundry V14 checks

- BODY 6 at Mortal 0: roll 1 passes both saves, 3 passes both (Stun equality),
  6 fails Stun but passes Death, and 10 fails both. No reversed crit colors.
- Check ordinary attack dice still explode and retain their normal critical
  presentation. Check manual save rolls never change actor conditions.
- Open an automatic weapon, select SemiAuto and fire: no suppression question.
  Reopen it: mode retained, situational modifiers and physical d10 cleared.
- Expand Advanced, change a modifier, then cancel a chosen template: the form
  retains inputs and no attack/ammunition change is applied.
- Switch shotgun selected/template targeting and verify disabled range and
  measured template distances, especially with no previously selected tokens.
- With manual d10 enabled, enter `10` (invalid), then `10,7` (valid), and verify
  only one attack is submitted. Double-click submit and check one outcome.
- Select Suppressive, cancel configuration/placement, then retry; check no zone
  or ammunition debit survives cancellation and successful placement charges once.
- Retain the final damage confirmation and check Cancel leaves all planned
  ammunition, wounds, armor and SDP changes unapplied.

Offline regression tests do not replace these checks in a disposable V14 world.
