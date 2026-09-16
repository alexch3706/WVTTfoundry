# Bestiary art sources

All **36** Core Bestiary & NPCs entries have a sheet portrait and a separate round
map token. **28 entries** use illustrations from the supplied books; **8 entries**
use generated replacements after a visual search through all six supplied books.
Variants may share a relevant illustration. This is not a set of 36 distinct
canonical portraits.

[Preview of all 36 tokens](https://github.com/alexch3706/WVTTfoundry/blob/v0.1.0-alpha.4/docs/witcher/bestiary-preview.png).

## Book-first review

Reviewed Core Rulebook v1.35, A Witcher's Journal, A Witcher’s Tools, A Book of
Tales, A Tome of Chaos v1.01, and Lords & Lands, including illustrations outside
the stat blocks. The cat and dog in Tome's familiar section depict supernatural
creatures and were unsuitable for ordinary animal records. Its supernatural bird
and the tiny decorative Core crow were also unsuitable. No usable ordinary
serpent, ox, mule, Kowal or Nowak portrait was found.

Book illustrations were extracted directly from the PDF image objects and encoded
as WebP, preserving their composition. The horse portraits use SVG viewports to
isolate the animal from a larger scene. Tokens use self-contained SVGs with a
circular crop and bronze frame; their embedded raster is the same source image.
They do not depend on external image hosts. The book files themselves are excluded.

## Assignment table

Pages below are printed page numbers; PDF page numbers are one higher. The exact
PDF image object, viewport coordinates and stable Actor IDs are recorded in
[`bestiary-art.json`](../../data/witcher/bestiary-art.json).

| Bestiary entry | Illustration source | Printed page / note |
| --- | --- | --- |
| Bandit | Core v1.35 | 270 |
| Mage | Core v1.35 | 272 |
| Scoia’tael Archer | Core v1.35 | 274 |
| Drowner | Core v1.35 | 276 |
| Ghoul | Core v1.35 | 278 |
| Grave Hag | Core v1.35 | 280 |
| Wraith | Core v1.35 | 282 |
| Noonwraith | Core v1.35 | 284 |
| Wolf | Core v1.35 | 286 |
| Warg | Core v1.35 | 286; shared with Wolf |
| Werewolf | Core v1.35 | 288 |
| Siren | Core v1.35 | 290 |
| Griffin | Core v1.35 | 292 |
| Endrega Worker | Core v1.35 | 294 |
| Endrega Warrior | Core v1.35 | 294; shared with Endrega Worker |
| Endrega Drone | Core v1.35 | 294; shared with Endrega Worker |
| Arachas | Core v1.35 | 296 |
| Golem | Core v1.35 | 298 |
| Fiend | Core v1.35 | 300 |
| Nekker | Core v1.35 | 302 |
| Nekker Chieftain | Core v1.35 | 244 |
| Rock Troll | Core v1.35 | 304 |
| Wyvern | Core v1.35 | 306 |
| Katakan | Core v1.35 | 308 |
| Endrega Queen | Core v1.35 | 296; shared with Arachas |
| Cat | Generated original | Ordinary animal |
| Dog | Generated original | Ordinary animal |
| Bird | Generated original | Ordinary animal |
| Serpent | Generated original | Ordinary animal |
| Horse | Tome of Chaos v1.01 | 105 |
| War Horse | Core v1.35 | 171 |
| Ox | Generated original | Ordinary animal |
| Mule | Generated original | Ordinary animal |
| “Crucible” Kowal | Generated original | Original interpretation, not a canonical portrait |
| Lord Nowak | Generated original | Original interpretation, not a canonical portrait |
| Woolabag | Core v1.35 | 304; shared with Rock Troll |

The Endrega Queen uses the Arachas illustration, matching Core p.294's direction
to use that creature's statistics. Warg, Endrega Warrior/Drone and Woolabag use
their related creature's art with separate token crops. The red-marked Nekker
Chieftain is taken from Core p.244. These shared images are explicitly recorded
rather than presented as separate illustrations of those variants.

## Generated replacements

Cat, Dog, Bird (raven), Serpent (adder), Ox, Mule, “Crucible” Kowal and Lord Nowak
were generated with the built-in `image_gen` tool. They are original illustrations
for this project, not official Witcher art. Prompts for the two NPCs use their
adventure descriptions; the faces are interpretations. The exact final prompts
are in [`generated-art-prompts.json`](../../data/witcher/generated-art-prompts.json).
Saved portraits are in [`assets/bestiary/portraits`](../../assets/bestiary/portraits/).

## Existing worlds

On world startup, the elected active GM replaces default mystery-man/pawprint
images on recognized imports from this system's bestiary. This includes Actor
portraits, prototype tokens and placed tokens in active and inactive scenes.
Renamed imports are recognized through compendium provenance. Older imports
without it require the system's book/page markers and an exact entry name.
Unrelated actors and user-selected images are preserved. No stats, inventory,
HP, positions, token sizes or scales are changed.

An unlinked token's old placeholder portrait override is cleared so its sheet
inherits the world Actor portrait. Custom portrait overrides are retained.
Individual failures are reported in the GM console; successful updates remain
in place. The GM can retry from the console with
`await game.witcher.updateBestiaryArt()` or restart the world. Repeating the scan
does not rewrite already assigned or custom images.

## Rebuilding and attribution

Run `npm run build:art` after editing the reviewed manifest, then
`npm run build:packs`. The builder regenerates the token SVGs, cropped horse
portraits, runtime migration catalog and compendium source image paths. Original
raster illustrations are inputs and are not regenerated by this command.

Book illustrations retain the copyright and attribution of their respective
books and artists; the repository's software license does not relicense that art.
The source books are published by R. Talsorian Games for The Witcher TTRPG, based
on The Witcher by Andrzej Sapkowski and CD PROJEKT RED. No official endorsement
is implied. The table distinguishes book illustrations from generated originals.
