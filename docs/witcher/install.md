# Install the Witcher system on Foundry V14 / The Forge

This is an independent system with installation ID **`witcher-rilerena`**.
Create a new world for it. A Cyberpunk world cannot be converted merely by
changing its system ID.

## The Forge

1. Select **Foundry V14** for the game on The Forge.
2. Open the [GitHub releases](https://github.com/alexch3706/WVTTfoundry/releases)
   and choose the version you intend to test. Expand its **Assets** and copy
   the link to **`system.json`**.
3. In The Forge's Bazaar, choose **Install from Manifest** and paste that link.
   If using the Foundry setup screen, use **Game Systems → Install System →
   Manifest URL** instead.
4. Create a world using **The Witcher TTRPG — Rilerena** and launch it.
5. Open a character and import equipment from the compendiums. The GM can
   import creatures from **Core Bestiary & NPCs** and place their tokens.

The Forge supports installing systems from a manifest URL. Its interface and
the setup options available depend on the account configuration. See the
[Forge setup guide](https://forums.forge-vtt.com/t/how-to-create-a-foundry-vtt-world-on-the-forge/660)
and [Bazaar guide](https://forums.forge-vtt.com/t/what-is-the-bazaar/4877).

### Prerelease URLs and updates

Use the manifest asset of the **specific release**, for example this URL shape:

```text
https://github.com/alexch3706/WVTTfoundry/releases/download/v<VERSION>/system.json
```

Replace `<VERSION>` with the exact version displayed on the chosen release,
including a suffix such as `-dev.2`. This is a URL example, not a published
version. The release manifest points to that same version's
`witcher-rilerena.zip`. Do not use GitHub's generated **Source code** archives.

Prereleases deliberately use a pinned manifest. To move to another prerelease,
back up the world and install the new release's manifest link. GitHub's
`releases/latest` endpoint is for stable releases and does not select a
prerelease, as described in the
[GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).
The release page remains the source for the available versions.

## Manual installation on a local Foundry server

Download **`witcher-rilerena.zip`** from the selected release. Extract its
contents into the Foundry user-data directory:

```text
Data/systems/witcher-rilerena/system.json
Data/systems/witcher-rilerena/module/witcher/main.js
Data/systems/witcher-rilerena/packs/witcher/...
```

The ZIP has `system.json` at its root. Create the `witcher-rilerena` directory
before extracting; do not add an extra nested `witcher-rilerena` directory.
Restart Foundry, select the installed system and create a new world.

Release assets include `SHA256SUMS` for the archive and standalone manifest.
On systems with `sha256sum`, download those three assets into one directory
and run `sha256sum --check SHA256SUMS`.

## What this release verifies

The build runs rules and package tests, rebuilds the actual compendiums, checks
JavaScript imports and template compilation, then reads back every file in the
installable ZIP. The archive excludes the inherited Cyberpunk runtime, source
PDFs, development dependencies and extraction inputs.

These checks **do not launch Foundry or verify live multiplayer behavior**.
Until an acceptance run is recorded, startup, rendering and GM/player
interactions still require verification on The Forge. Use the included
`docs/witcher/forge-checklist.md` for this run and report the release version,
reproduction steps and browser-console errors when something fails.

The current focus is ordinary attacks and defenses, fast/strong strikes and
STA, equipment and ammunition, creature attacks, hit locations, armor, silver,
resistances and Witcher equipment. Alpha.6 adds an initial magic implementation;
use the [magic play guide](magic-play-guide.md) and [support matrix](magic-progress.md)
for the available casting, ritual and hex procedures. Mounted combat and broader
profession/creature abilities remain outside the current priority. Presence of
a rule description or button does not certify automation.
The included `docs/witcher/implementation-status.md` and `docs/witcher/bestiary.md`
record scope, source interpretations and remaining limitations.
