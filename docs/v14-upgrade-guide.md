# Upgrading a Cyberpunk 2020 World to Foundry V14

This guide covers the `2.0.0` system line on Foundry VTT 14 Stable 7 (`14.365`). The system keeps the same ID, `cyberpunk2020-rilerena`, so an existing world can use it during the core migration.

Do not perform the first V14 launch on the only copy of a campaign. Foundry's core world-data migration is not designed to be downgraded in place.

## Before the upgrade

1. Stop the world and make a complete, restorable backup of its world-data directory. On Forge, also use the provider's backup/export facility.
2. Create a disposable copy of the campaign. Never use the production copy for either staging migration.
3. First open the disposable copy on the latest stable V13 with the last V13-compatible `1.x` release of this system. Let V13 finish any pending core migration, save the world, and perform a basic sheet/roll smoke test. This is required even when the package's old manifest also allowed earlier core versions: V14 no longer carries core migration support for data older than V13 ([upstream database-migration notice](https://github.com/foundryvtt/foundryvtt/issues/13436)).
4. Shut the V13 copy down cleanly, then make and verify a second backup from that fully opened latest-V13 state. Treat this second backup—not an older world snapshot—as the input to the V14 rehearsal.
5. Record the exact V13 build, system version, enabled modules, and any macros or journal links that reference this system's compendia.
6. Stage Cyberpunk 2020 `2.0.0` as part of the V14 upgrade, but do not open the copied world until both core and system are ready. On a self-hosted installation, upgrade the core, return to the V14 Setup screen, install/update the system there, and only then launch the copy. On Forge, select the V14-compatible system release in the provider's upgrade flow before allowing the first V14 world launch. Confirm that its package folder/ID remains `cyberpunk2020-rilerena`.
7. Leave all modules disabled for the first V14 launch. Foundry disables modules during a major core migration; re-enable only modules which explicitly support V14, in small batches after the system-only checks pass.

The number of modules shown by a hosting provider may include packages installed for other worlds or systems. It does not increase the amount of Cyberpunk system data that this migration rewrites, but every module enabled in this world still needs an independent V14 compatibility check.

## First V14 launch

1. Launch the latest-V13-staged copy as the primary active GM and accept Foundry's V13-to-V14 core migration.
2. Wait for the permanent `Cyberpunk2020 System Migration ... completed` notification. Only one active GM runs the system migration. The completion marker is written only after every required update/deletion is acknowledged, locked world packs are confirmed locked again, and Foundry reports neither uninitialized documents nor recorded validation failures in that scope.
3. If either Foundry or the system reports a migration error, stop and preserve the browser/server logs. The system leaves its completion marker unset and can recover an interrupted pack relock on the next run, but diagnose the copied world first; use a fresh copy of the backup whenever the cause is unclear.
4. Do not interpret a successful launch as complete validation. Work through the checks below before migrating the production copy.

## Required smoke tests

- Open existing character, NPC, weapon, armor, cyberware, and vehicle sheets; edit one disposable field and reload the world.
- Create a new character and confirm the default-skill compendium populates it.
- On campaigns previously used in Spanish or Italian, inspect trained skills for leftover localized pairs such as `Handgun` / `Armas Cortas` / `Pistole`. The migration folds these when the authoritative legacy skill map still exists and aborts on conflicting progress; if that map was manually removed by an earlier cleanup, compare and resolve any duplicate-looking custom Items manually rather than assuming equal names are safe to merge.
- Open several item compendia, drag an item onto an actor, and roll the Hit Location RollTable.
- Make a normal roll and verify its chat card renders without console compatibility errors.
- Place and cancel shotgun cone/circle/line areas. Confirm cancellation creates no Scene Region and no attack-side state changes.
- Complete a shotgun placement and confirm its transient Region is removed after target evidence is captured.
- Place suppressive fire, confirm its Region persists for the intended duration, resolves token containment correctly, and is then removed.
- Repeat spatial checks with a non-zero token elevation and with a player account that has the intended token/scene permissions.
- Run the full combat checklist in [Foundry manual checks](./testing/foundry-manual-checks.md), then re-enable required V14-compatible modules in small batches and repeat the critical rolls.

## Compendium IDs

V14 no longer repairs invalid pack IDs while loading a package. The existing IDs in this system were checked against the V14 validator and are already valid, including `netrunningEquipment`, `heavyWeapons`, and `weapons_other`. Version 2.0.0 therefore preserves every collection ID and on-disk path exactly. Existing compendium UUIDs, macros, and third-party `game.packs.get(...)` calls do not need redirects or data rewriting.

## Go/no-go rule

Migrate the production world only after the copied world passes system-only smoke tests, the campaign's required modules have been re-enabled and checked, and the backup has been restored once as a drill. If validation fails, return to the untouched V13 backup rather than attempting to downgrade the migrated V14 data.

Automated repository checks cover code contracts, manifest metadata, and all shipped compendium documents. They do not replace a licensed Foundry V14 browser/canvas smoke test.
