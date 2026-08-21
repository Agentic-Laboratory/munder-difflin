# Wizarding School — art contract

**Atlas:** `wizardschool-castle.png` · **Generator:** `tools/wizardschool-art/gen-art.cjs` · **Theme:** `wizardschool`

## Licence

Every pixel in `wizardschool-castle.png` is authored from scratch by the generator (pure Node `zlib`, zero dependencies). Nothing is copied, traced or recoloured from another tileset, so this atlas carries **no third-party licence** and none of the non-commercial restriction that applies to the vendored LimeZu art in `ATTRIBUTION.md`. No tile depicts anyone's likeness.

The *art* is original; the **names are not**. This fork labels the four houses and the ten characters with the real Harry Potter cast — a local naming choice for our own build, not original writing, and not something to carry upstream without the rights holder's blessing. The internal character ids (`sable`, `ashcroft`, …) stay generic because they are persisted in live user data and must never be renamed; only the display names borrow.

The map does still reference two LimeZu pieces from the embedded office atlas, so the restriction in `ATTRIBUTION.md` continues to apply to the theme as a whole:

| Piece | gids | Where |
| --- | --- | --- |
| Wooden bookcase, 2x2 | 153, 154 / 169, 170 | Classroom and common room |
| Armchairs | 257, 259 | Common room, facing the hearth |

Replacing those two with generated equivalents is all that stands between this theme's *art* and being fully licence-clean. The borrowed display names are a separate question — see Licence above.

## Atlas format

| Property | Value |
| --- | --- |
| Size | 256 x 112 px |
| Tile | 16 x 16 px |
| Columns | 16 |
| `tilecount` | 112 (98 drawn; the rest are reserved blanks) |
| `firstgid` | 2449, i.e. `1025 + 1424`, immediately after `interiors` |

`gid = 2449 + local index`. `resolveTileset` walks the tileset array backwards and takes the first entry whose `firstgid` is at or below the tile id, so this atlas must stay last in both `ThemeConfig.tilesets` and the map's own `tilesets` array.

## Tile index

Local indices, row-major. Blanks are reserved for later additions.

| Row | Index | Contents |
| --- | --- | --- |
| 0 | 0-6 | Flagstone paving: plain A/B, cracked, mossy, dark slate A/B, warm hall stone |
| 0 | 7-10 | Stone stair tread; carpet runner left / centre / right |
| 0 | 11-14 | Enchanted ceiling (night, stars); doorway threshold; floor rune circle |
| 1 | 16-19 | Wall body A/B, top cornice, base skirting |
| 1 | 20-25 | Pillar top / body / base; shadowed wall; wall plaque; buttress rib |
| 2 | 32-35 | Arched window, 2x2 (TL, TR, BL, BR) |
| 2 | 36-39 | Stained-glass window, 2x2 |
| 2 | 40-46 | Doorway arch L/R; oak door L/R; portcullis; dark passage; arrow slit |
| 3 | 48-55 | House banners, 2 tiles each: Gryffindor, Slytherin, Ravenclaw, Hufflepuff |
| 3 | 56-59 | Banner rail; house-points hourglass; tapestry top / bottom |
| 4 | 64-68 | Wall torch; candelabra top / base; floating candles; brazier |
| 4 | 69-71 | Hearth left jamb / fire / right jamb |
| 4 | **72, 73** | **Seat marker OFF, top row** |
| 4 | **74, 75** | **Seat marker ON, top row** |
| 4 | 76-77 | Unlit sconce; hanging lantern |
| 5 | 80-85 | Refectory table: far row, near row, +platter, +place setting, end L/R |
| 5 | 86-87 | Bench middle / end |
| 5 | **88, 89** | **Seat marker OFF, bottom row** |
| 5 | **90, 91** | **Seat marker ON, bottom row** |
| 5 | 92-95 | High table far / near; carved chair; lectern |
| 6 | 96-103 | Cauldron; cauldron lit; potion shelf; inkwell; scrolls; spellbook; crystal ball; owl perch |
| 6 | 104-111 | Herbology pot; notice board; clock; suit of armour top / bottom; barrel; broom; pumpkin |

## The seat marker

This replaces the office desk monitor and is the fiddliest part of the atlas. A self-writing spellbook: closed on the table, open and glowing while its reader is seated.

Two 2x2 blocks, side by side, matching how the office tileset pairs its off and on monitors:

```
OFF  72 73        ON  74 75          offTopLeftGid = 2521
     88 89            90 91          onGids = [[2523,0,0],[2524,1,0],[2539,0,1],[2540,1,1]]
```

Three constraints bind this art and none of them are configurable:

1. **Placement.** `OfficeFloor.tsx:1407` attaches a `DeskScreen` only when the off block's top-left gid is painted on the `furniture-above` layer at exactly `(seat.x, seat.y - 2)`. This is why the hall's tables run east-west with benches on their south edge.
2. **The page area.** `DeskScreen.ts:25` hardcodes `SCREEN = { x: 3, y: 5, w: 25, h: 12 }` in block-local pixels and animates pale blue scrolling lines and a blinking cursor inside it. No `MonitorConfig` field can move it. The open book's page field is drawn to sit exactly there, so the animation reads as text writing itself onto the page rather than as a stray rectangle.
3. **Coverage.** The ON block is drawn over the OFF block, not instead of it. The open book's silhouette must fully contain the closed book's, or the closed cover peeks out from underneath while an agent is seated.

## Regenerating

```
node tools/wizardschool-art/gen-art.cjs      # atlas
node tools/gen-wizardschool-map.cjs          # map, validates before writing
```

Order matters. The map's gids are computed from the atlas layout, so freeze the tile index above before authoring the map. The map generator refuses to write if any seat, café stand, coffee tile or errand stand is unreachable from the entrance, if a seat has no walkable approach, if a seat marker is missing or misplaced, or if any painted gid falls outside a declared atlas.

To see the result without launching Electron:

```
python3 tools/mapgen/render_map.py src/renderer/src/assets/maps/wizardschool.tmj /tmp/hall.png --labels
```
