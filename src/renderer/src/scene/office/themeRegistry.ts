// Theme registry — the pluggable "office theme" contract.
//
// Phase 0 of the TV-show-offices feature (card tvshow-phase0-abstraction):
// extract the ~40% of constants that were hard-coded inside OfficeFloor.tsx
// (errand spots, coffee-economy tile coords, prop anchors, seat names, tileset
// URLs, palette, monitor gids) into a ThemeConfig so the scene becomes
// swappable per show. This phase ships the EXISTING office unchanged as
// `theme: 'office'`: every value below is copied byte-for-byte from the old
// in-file literals, so the office renders and behaves identically.
//
// The engine (TiledMapRenderer / BFS pathfinding / Camera / sprite animation)
// is already fully generic and needs no change. cast.ts is read-only here
// (uncommitted human WIP) — the office theme references its existing exports.

import type { Texture } from 'pixi.js';
import { colors } from '@/design/tokens';
import {
  CAST_BY_NAME,
  WIZARD_CAST_BY_NAME,
  WIZARD_DEFAULT_CHARACTER,
  getCastFrames,
  DEFAULT_CHARACTER,
  type CastMember,
  type CharacterName,
} from './cast';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
// .tmj is Tiled JSON; imported as raw text and parsed by the loader.
import officeMapRaw from '@/assets/maps/office.tmj?raw';
import brooklyn99MapRaw from '@/assets/maps/brooklyn99.tmj?raw';
import wizardschoolCastleUrl from '@/assets/tilesets/wizardschool-castle.png?url';
import wizardschoolMapRaw from '@/assets/maps/wizardschool.tmj?raw';

/** Theme identifiers. `office`, `brooklyn99` and `wizardschool` are registered
 *  in THEMES below; the rest land in later phases and fall back to the office.
 *  `wizardschool` was called `hogwarts` before it was built — see LEGACY_THEME_IDS
 *  in themeLoader for the rename shim. */
export type ThemeId =
  | 'office'
  | 'friends'
  | 'brooklyn99'
  | 'siliconvalley'
  | 'got'
  | 'wizardschool';

export interface Tile { x: number; y: number; }
export type Facing = 'up' | 'down' | 'left' | 'right';

/** Kinds of small idle errands around the office (incl. plant watering).
 *  'smoke' is the boss special: cigar at the open window, god only. */
export type ErrandKind =
  | 'water' | 'window' | 'dispenser' | 'fridge' | 'shelf' | 'bin' | 'smoke';

/** One idle-errand anchor: a stand tile + facing, an `fx` tile for the ambient
 *  animation, a duration, and an optional god-only restriction. */
export interface ErrandSpot {
  kind: ErrandKind;
  stand: Tile;
  facing: Facing;
  fx: Tile;
  duration: number;
  godOnly?: boolean;
}

/** One tileset atlas + its placement in the global gid space. `embedded` marks
 *  the atlas whose metadata already lives inline in the map's own `tilesets[0]`
 *  (the loader keeps the map's copy and only patches the appended atlases). */
export interface TilesetEntry {
  url: string;
  embedded?: boolean;
  firstgid?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  tilecount?: number;
}

/** Desk-monitor overlay gids. The map paints an OFF monitor block; DeskScreen
 *  overlays the matching ON tiles while the desk's agent is seated. */
export interface MonitorConfig {
  /** gid of the OFF monitor block's top-left tile, as painted in the map. */
  offTopLeftGid: number;
  /** Matching ON tiles as [gid, dx, dy] relative to the block's top-left. */
  onGids: ReadonlyArray<readonly [number, number, number]>;
}

/** The coffee economy's fixed tiles: sideboard (mug rack) → counter machine →
 *  sink → back to the sideboard. `maxCups` caps the clean-mug stock.
 *
 *  `*Tile` names the OBJECT (map art the Graphics draw over); `*Stand` names the
 *  walkable tile an agent paths to. The two are never the same tile — a stand
 *  inside collision is unreachable and the errand silently never completes. */
export interface CoffeeConfig {
  trayTile: Tile;
  trayStand: Tile;
  /** The machine itself — where the steam rises from. Was hardcoded to the
   *  office's (26,17) in OfficeFloor, three rows above its own stand. */
  machineTile: Tile;
  machineStand: Tile;
  sinkTile: Tile;
  sinkStand: Tile;
  maxCups: number;
}

/** Clickable prop anchors (tile coords). calendar → TRIGGERS, boards → TASKS,
 *  askMe → ASK ME, clock → CLOSING TIME.
 *
 *  Everything here was hardcoded to the office's own coordinates until the
 *  Wizarding School theme landed on top of it. The failures are all silent, so
 *  test/theme-contract.test.cjs asserts each one per theme: a board stand inside
 *  collision leaves `Character.walkToAndThen` with no path, which drops the
 *  arrival callback and strands the choreography until the 30 s watchdog. */
export interface AnchorConfig {
  calendar: Tile;
  boards: Tile;
  /** px nudge centring the 82px board ensemble on THIS theme's wall run
   *  (the office's own 15 is the default). */
  boardsPad?: number;
  /** Where an actor stands to pin / take / archive a note. Must be walkable
   *  AND reachable from the entrance. */
  boardStands: { pin: Tile; take: Tile; archive: Tile };
  clock: Tile;
  /** Click extent in px. The office clock is a two-tile sprite (16x32); a
   *  single-tile clock is 16x16, and the default would hang a dead 16px of
   *  hit area into the tile below it. */
  clockSize?: { w: number; h: number };
  askMe: Tile;
  askMePad?: number;
}

/** An extra clickable object on the floor: a hit area over art the theme's map
 *  ALREADY paints, opening one Command Center tab.
 *
 *  The split matters. OfficeFloor supplies only the hit area, a hover outline and
 *  the label; the art belongs to the map. The four older props (calendar, task
 *  boards, clock, ASK ME) draw their own art in code, which is exactly why they
 *  spent a whole theme cycle carrying the office's coordinates — there was no way
 *  to reskin them without touching the scene. Nothing here can rot that way. */
export interface ClickableProp {
  /** A tab key from CommandCenterPanel's CCTab union. */
  tab: string;
  /** Top-left tile of the art this prop sits on. */
  tile: Tile;
  /** Hit area in tiles (default 1x1) — size it to the art. */
  w?: number;
  h?: number;
  /** Shown on hover. Carries the meaning, so the art need not be literal. */
  label: string;
}

/** Colors for the props OfficeFloor draws with Graphics rather than map tiles —
 *  the wall calendar, the two task boards, the archive table and the ASK ME
 *  board. The geometry is shared; only the palette is per-theme, which is what
 *  lets a castle hang parchment on oak where the office hangs paper on cork. */
export interface PropStyle {
  /** board frame + archive-table legs */
  frame: number;
  /** the pinnable surface: cork, or parchment */
  surface: number;
  /** a note whose status isn't in noteColors */
  noteFallback: number;
  /** pin heads, the calendar's nail and frame */
  pin: number;
  pileBack: number;
  pileFront: number;
  /** the calendar: page, month banner, binding rings, day grid */
  page: number;
  banner: number;
  rings: number;
  grid: number;
  /** the archive table + the edge stroke on a filed sheet */
  table: number;
  tableShade: number;
  doneEdge: number;
  /** the ASK ME board: frame, header/notes/pulse, quiet "?" watermark */
  askFrame: number;
  askAccent: number;
  askWatermark: number;
}

/** Theme palette. `background` is the canvas clear color; `noteColors` are the
 *  kanban note colors keyed by task status. */
export interface PaletteConfig {
  background: number;
  noteColors: Record<string, number>;
  propStyle: PropStyle;
}

/** Per-theme cast loader — the indirection point so a future show can swap its
 *  own roster + sprite frames. The office theme points at cast.ts's exports. */
export interface ThemeCast {
  byName: Record<string, CastMember>;
  getFrames: (name: string) => Promise<Texture[][]>;
  defaultCharacter: string;
}

/** The full contract a theme must supply. See report §A (theme contract). */
export interface ThemeConfig {
  id: ThemeId;
  /** Raw Tiled JSON text; parsed + tileset-patched by themeLoader. */
  mapRaw: string;
  /** Ordered atlases — order matches both the texture load order and the map's
   *  tileset array (texture[i] ↔ tilesets[i]). */
  tilesets: TilesetEntry[];
  /** Desk-claim order, by spawn-point name (seat 0 = god / desk-ceo). */
  primarySeatNames: string[];
  /** Paired café table seats, in order. */
  cafeSeatNames: string[];
  /** Café standing spots: [spawn-point name, kind]. */
  cafeStands: ReadonlyArray<readonly [string, 'coffee' | 'vending']>;
  coffee: CoffeeConfig;
  anchors: AnchorConfig;
  /** Optional extra click targets on furniture the map already paints. */
  props?: ClickableProp[];
  errandSpots: ErrandSpot[];
  monitor: MonitorConfig;
  palette: PaletteConfig;
  cast: ThemeCast;
}

/** The existing office, expressed as a theme. Values are copied verbatim from
 *  the former in-file constants in OfficeFloor.tsx / DeskScreen.ts. */
export const OFFICE_THEME: ThemeConfig = {
  id: 'office',
  mapRaw: officeMapRaw,
  tilesets: [
    // office-tileset.png — embedded in the map (firstgid 1); keep the map's copy.
    { url: officeTilesetUrl, embedded: true },
    { url: a5FloorsWallsUrl, firstgid: 513, image: 'a5', imagewidth: 256, imageheight: 512, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 512 },
    { url: interiorsUrl, firstgid: 1025, image: 'interiors', imagewidth: 256, imageheight: 1424, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 1424 },
  ],
  primarySeatNames: [
    'desk-ceo',
    'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5', 'pc-6',
    'desk-chief-architect', 'desk-product-manager', 'desk-team-lead',
    'desk-backend-engineer', 'desk-ui-ux-expert', 'desk-data-engineer',
    'desk-project-manager', 'desk-market-researcher', 'desk-agent-organizer',
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  coffee: {
    trayTile: { x: 29, y: 15 },     // the sideboard (counter piece)
    trayStand: { x: 29, y: 16 },
    machineTile: { x: 26, y: 17 },  // the machine on the counter (gid 313)
    machineStand: { x: 26, y: 20 }, // below the counter machine
    sinkTile: { x: 28, y: 18 },     // free counter top, right end
    sinkStand: { x: 28, y: 20 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },
    boards: { x: 6, y: 10 },
    boardsPad: 15,                  // centres the ensemble on the wall run 6..12
    boardStands: { pin: { x: 8, y: 11 }, take: { x: 9, y: 11 }, archive: { x: 12, y: 11 } },
    clock: { x: 1, y: 1 },
    clockSize: { w: 16, h: 32 },    // gids 354 + 370: a two-tile wall clock
    askMe: { x: 14, y: 10 },
    askMePad: 25,
  },
  // Three Command Center tabs that had no way onto the floor, hung on furniture
  // the office map already paints. The hover label carries the meaning, so the
  // art only has to be the most fitting thing in the room.
  props: [
    { tab: 'memory', tile: { x: 30, y: 17 }, w: 2, h: 3, label: 'memory' },   // the binder shelf
    { tab: 'skills', tile: { x: 30, y: 11 }, w: 3, h: 4, label: 'skills' },   // the vending machine
    { tab: 'workers', tile: { x: 11, y: 3 }, w: 4, h: 4, label: 'workers' },  // the conference table
  ],
  errandSpots: [
    // plants (droplets ride on the character via startWatering)
    { kind: 'water', stand: { x: 2, y: 20 }, facing: 'left', fx: { x: 1, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 22, y: 20 }, facing: 'right', fx: { x: 23, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 30, y: 20 }, facing: 'right', fx: { x: 31, y: 20 }, duration: 4.5 },
    // the CEO office is the god's domain: its plant, window, cigar. Workers
    // never set foot in there for errands.
    { kind: 'water', stand: { x: 6, y: 4 }, facing: 'up', fx: { x: 6, y: 3 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 2, y: 3 }, facing: 'up', fx: { x: 2, y: 1 }, duration: 18, godOnly: true },
    { kind: 'water', stand: { x: 17, y: 4 }, facing: 'up', fx: { x: 17, y: 3 }, duration: 4.5 },
    // the two public wall windows — wind streaks drift into the room
    { kind: 'window', stand: { x: 10, y: 3 }, facing: 'up', fx: { x: 10, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 15, y: 3 }, facing: 'up', fx: { x: 14, y: 1 }, duration: 5 },
    // water dispensers (hallway + the top-right corner one)
    { kind: 'dispenser', stand: { x: 16, y: 3 }, facing: 'down', fx: { x: 16, y: 4 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 32, y: 4 }, facing: 'up', fx: { x: 32, y: 3 }, duration: 3.5 },
    // the café fridge (door light spills out) + the shelf beside it
    { kind: 'fridge', stand: { x: 29, y: 20 }, facing: 'up', fx: { x: 29, y: 19 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 30, y: 20 }, facing: 'up', fx: { x: 30, y: 18 }, duration: 4 },
    // garbage bins (entrance + café) — a paper ball arcs in
    { kind: 'bin', stand: { x: 18, y: 20 }, facing: 'left', fx: { x: 17, y: 20 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 31, y: 16 }, facing: 'right', fx: { x: 32, y: 16 }, duration: 2.6 },
  ],
  monitor: {
    offTopLeftGid: 365,
    onGids: [
      [367, 0, 0], [368, 1, 0],
      [383, 0, 1], [384, 1, 1],
    ],
  },
  palette: {
    background: colors.ink[900],
    noteColors: { todo: 0xf2df8a, doing: 0x9ecbf0, blocked: 0xf0a3a3, done: 0xa8e0b0 },
    // Lifted verbatim from the inline hex in OfficeFloor's draw code, so the
    // office floor is pixel-identical to before the extraction.
    propStyle: {
      frame: 0x6e5639, surface: 0xc9b083, noteFallback: 0xf2eddc, pin: 0x4a3b52,
      pileBack: 0xe8e0c8, pileFront: 0xf2eddc,
      page: 0xf2ead8, banner: 0xc94f4f, rings: 0xd8d3c4, grid: 0xb8ab90,
      table: 0xb08d5e, tableShade: 0x8a6f4d, doneEdge: 0x6e8f6e,
      askFrame: 0x5b4a6b, askAccent: 0xcdb4e8, askWatermark: 0x8a755f,
    },
  },
  cast: {
    byName: CAST_BY_NAME as Record<string, CastMember>,
    getFrames: (name: string) => getCastFrames(name as CharacterName),
    defaultCharacter: DEFAULT_CHARACTER,
  },
};

/** Brooklyn Nine-Nine — the 99th precinct (TV-show offices Phase 2, structure).
 *  The map (brooklyn99.tmj) is a precinct bullpen: Captain Holt's glass office
 *  in the back corner (`desk-ceo`), an 8-desk detective bullpen (`pc-1..8`), a
 *  briefing room (boardroom zone) + break room (cafeteria zone) with the coffee
 *  economy. PLACEHOLDER ART: the map reuses the office tileset gids, so the
 *  tilesets / monitor / palette / cast below reuse the office theme verbatim —
 *  Pam's license-clean B99 tileset + cast likenesses (§C/§D) drop into those
 *  same seams later. Only the layout-bound anchors (seats, café, coffee, props,
 *  errands) are authored to brooklyn99.tmj's own coordinates. */
export const BROOKLYN99_THEME: ThemeConfig = {
  id: 'brooklyn99',
  mapRaw: brooklyn99MapRaw,
  // PLACEHOLDER: brooklyn99.tmj uses the office gid space, so the same atlases
  // (office-tileset embedded @1, a5 @513, interiors @1025) resolve every tile.
  tilesets: OFFICE_THEME.tilesets,
  primarySeatNames: [
    'desk-ceo',                                            // Captain Holt's glass office
    'pc-1', 'pc-2', 'pc-3', 'pc-4',                        // bullpen — front row
    'pc-5', 'pc-6', 'pc-7', 'pc-8',                        // bullpen — back row
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // Authored onto the break-room counter the generator now paints at rows 18-19
  // (x 30..33). Before that counter existed these tiles sat on bare floor, so
  // the mug rack, the basin and the steam all drew over nothing.
  coffee: {
    trayTile: { x: 33, y: 18 },     // counter top, right end
    trayStand: { x: 33, y: 20 },
    machineTile: { x: 30, y: 18 },  // the machine (gid 313) on the counter
    machineStand: { x: 30, y: 20 }, // below it — same tile as cafe-stand-coffee
    sinkTile: { x: 32, y: 18 },
    sinkStand: { x: 32, y: 20 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },   // briefing-room top wall → TRIGGERS
    boards: { x: 14, y: 1 },    // over the bullpen → TASKS
    // The bullpen's north band is walkable, so the stands sit one row under the
    // boards; each is positioned beneath the piece it serves.
    boardStands: { pin: { x: 15, y: 2 }, take: { x: 18, y: 2 }, archive: { x: 20, y: 2 } },
    clock: { x: 1, y: 1 },      // top-left corner → CLOSING TIME
    askMe: { x: 21, y: 1 },     // right of the boards, clear of the x=27 divider
    askMePad: 25,
  },
  // On art the generator paints for exactly this purpose: evidence lockers in
  // the bullpen, the briefing room's chalkboard and its duty-roster board.
  props: [
    { tab: 'memory', tile: { x: 25, y: 1 }, w: 2, h: 2, label: 'memory' },
    { tab: 'skills', tile: { x: 2, y: 1 }, w: 2, h: 2, label: 'skills' },
    { tab: 'workers', tile: { x: 7, y: 1 }, w: 2, h: 2, label: 'workers' },
  ],
  // Placeholder errand anchors authored to brooklyn99.tmj's open floor (verified
  // walkable against the map's collision layer + desk stamps). The godOnly spots
  // sit inside Holt's glass office.
  errandSpots: [
    // public plants around the bullpen
    { kind: 'water', stand: { x: 2, y: 13 }, facing: 'left', fx: { x: 1, y: 13 }, duration: 4.5 },
    { kind: 'water', stand: { x: 24, y: 15 }, facing: 'right', fx: { x: 25, y: 15 }, duration: 4.5 },
    { kind: 'water', stand: { x: 13, y: 15 }, facing: 'down', fx: { x: 13, y: 16 }, duration: 4.5 },
    // Captain Holt's glass office — god's domain (plant + cigar at the window)
    { kind: 'water', stand: { x: 28, y: 6 }, facing: 'up', fx: { x: 28, y: 5 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 34, y: 2 }, facing: 'up', fx: { x: 34, y: 0 }, duration: 18, godOnly: true },
    // public windows on the north wall — wind streaks drift in
    { kind: 'window', stand: { x: 14, y: 1 }, facing: 'up', fx: { x: 14, y: 0 }, duration: 5 },
    { kind: 'window', stand: { x: 22, y: 1 }, facing: 'up', fx: { x: 22, y: 0 }, duration: 5 },
    // water dispensers (bullpen + entrance corridor)
    { kind: 'dispenser', stand: { x: 8, y: 15 }, facing: 'down', fx: { x: 8, y: 16 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 17, y: 20 }, facing: 'down', fx: { x: 17, y: 21 }, duration: 3.5 },
    // break-room fridge + shelf (by the coffee economy)
    { kind: 'fridge', stand: { x: 29, y: 21 }, facing: 'up', fx: { x: 29, y: 20 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 34, y: 18 }, facing: 'up', fx: { x: 34, y: 17 }, duration: 4 },
    // garbage bins (entrance + break room)
    { kind: 'bin', stand: { x: 19, y: 20 }, facing: 'left', fx: { x: 18, y: 20 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 34, y: 15 }, facing: 'up', fx: { x: 34, y: 14 }, duration: 2.6 },
  ],
  // PLACEHOLDER: brooklyn99.tmj paints the office desk stamp (monitor gid 365).
  monitor: OFFICE_THEME.monitor,
  // PLACEHOLDER: office palette + cast until Pam's B99 art (§C/§D) lands.
  palette: OFFICE_THEME.palette,
  cast: OFFICE_THEME.cast,
};

/** Wizarding School — a castle great hall.
 *
 *  Unlike brooklyn99 this is NOT placeholder art: `wizardschool-castle.png` is an
 *  original atlas appended at firstgid 2449 (generated by
 *  tools/wizardschool-art/gen-art.cjs) and the cast is ten new procedural recipes
 *  in portraitArt.ts. The three office atlases stay in the list because the map
 *  borrows two pieces from the embedded one — the wooden bookcase and armchairs —
 *  and because index order must match the map's own tileset array.
 *
 *  Layout: a high table at the head of the room (desk-ceo), four long house tables
 *  split by a carpeted aisle (pc-1..16), a potions classroom (boardroom zone) and a
 *  common room with the hearth and the tea trolley (cafeteria zone). Tables run
 *  east-west with benches on their south edge because the seat marker must sit at
 *  (seat.x, seat.y - 2) for OfficeFloor to light it. */
export const WIZARDSCHOOL_THEME: ThemeConfig = {
  id: 'wizardschool',
  mapRaw: wizardschoolMapRaw,
  tilesets: [
    ...OFFICE_THEME.tilesets,
    { url: wizardschoolCastleUrl, firstgid: 2449, image: 'wizardschool-castle', imagewidth: 256, imageheight: 112, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 112 },
  ],
  primarySeatNames: [
    'desk-ceo',                                                    // the high table
    'pc-1', 'pc-2', 'pc-3', 'pc-4',                                // Emberwing
    'pc-5', 'pc-6', 'pc-7', 'pc-8',                                // Nightthistle
    'pc-9', 'pc-10', 'pc-11', 'pc-12',                             // Skyquill
    'pc-13', 'pc-14', 'pc-15', 'pc-16',                            // Goldbriar
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // The tea trolley in the common room, keeping the coffee economy's mechanics.
  coffee: {
    trayTile: { x: 30, y: 16 },     // the cup rack
    trayStand: { x: 30, y: 17 },
    machineTile: { x: 32, y: 16 },  // the urn itself — steam rises here
    machineStand: { x: 32, y: 17 }, // below the urn
    sinkTile: { x: 34, y: 16 },     // the wash basin
    sinkStand: { x: 34, y: 17 },
    maxCups: 4,
  },
  // The great hall's north wall is fully dressed — four house banners (x 6, 12,
  // 18, 23), four arched windows (3-4, 9-10, 15-16, 21-22) and the open vault
  // (7-8) — and every prop here hangs across wall rows 0.5..1.9, so anything
  // wide would cover that art. Only the single-tile props go on it; the 82px
  // board ensemble hangs in the common room instead, on the divider wall at
  // row 12, which is exactly the wall a common-room notice board wants.
  anchors: {
    calendar: { x: 13, y: 1 },  // plain wall between the banner and the window -> TRIGGERS
    boards: { x: 28, y: 12 },   // the common room's north wall -> TASKS
    boardsPad: 0,               // the run starts at the anchor; the office's 15 would overhang it
    // Row 13, clear of the bookcase at x 26-27. Each stand sits under the piece
    // it serves: blockers 28..29.9, todo 30.1..32, archive table 32.2..33.1.
    boardStands: { pin: { x: 29, y: 13 }, take: { x: 31, y: 13 }, archive: { x: 32, y: 13 } },
    clock: { x: 1, y: 1 },      // -> CLOSING TIME
    clockSize: { w: 16, h: 16 },// the castle atlas clock is a single tile
    askMe: { x: 28, y: 1 },     // the classroom's undressed north wall -> ASK ME
    askMePad: 0,
  },
  // The castle already had the right three objects: what the school remembers,
  // what it can cast, and where its students work.
  props: [
    { tab: 'memory', tile: { x: 26, y: 13 }, w: 2, h: 2, label: 'memory' },   // the common-room bookcase
    { tab: 'skills', tile: { x: 31, y: 3 }, label: 'skills' },                // the potions shelf
    { tab: 'workers', tile: { x: 27, y: 6 }, w: 4, h: 1, label: 'workers' },  // the brewing tables
  ],
  // Authored against wizardschool.tmj and asserted walkable by the map
  // generator's validator (tools/gen-wizardschool-map.cjs).
  errandSpots: [
    { kind: 'water', stand: { x: 2, y: 6 }, facing: 'left', fx: { x: 1, y: 6 }, duration: 4.5 },
    { kind: 'water', stand: { x: 23, y: 6 }, facing: 'right', fx: { x: 24, y: 6 }, duration: 4.5 },
    { kind: 'water', stand: { x: 28, y: 10 }, facing: 'down', fx: { x: 28, y: 11 }, duration: 4.5 },
    // the head of the hall is the headmaster's domain: their plant, their window.
    { kind: 'water', stand: { x: 7, y: 5 }, facing: 'up', fx: { x: 7, y: 4 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 3, y: 3 }, facing: 'up', fx: { x: 3, y: 1 }, duration: 18, godOnly: true },
    { kind: 'window', stand: { x: 4, y: 3 }, facing: 'up', fx: { x: 4, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 22, y: 3 }, facing: 'up', fx: { x: 22, y: 1 }, duration: 5 },
    { kind: 'dispenser', stand: { x: 2, y: 23 }, facing: 'left', fx: { x: 1, y: 23 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 30, y: 23 }, facing: 'down', fx: { x: 30, y: 24 }, duration: 3.5 },
    { kind: 'fridge', stand: { x: 36, y: 16 }, facing: 'up', fx: { x: 36, y: 15 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 31, y: 4 }, facing: 'up', fx: { x: 31, y: 3 }, duration: 4 },
    { kind: 'bin', stand: { x: 23, y: 23 }, facing: 'right', fx: { x: 24, y: 23 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 27, y: 22 }, facing: 'left', fx: { x: 26, y: 22 }, duration: 2.6 },
  ],
  // A self-writing spellbook instead of a desk PC: closed on the table, open and
  // glowing while its reader is seated. Local indices 72/73 + 88/89 (off) and
  // 74/75 + 90/91 (on) in the castle atlas, offset by firstgid 2449.
  monitor: {
    offTopLeftGid: 2521,
    onGids: [
      [2523, 0, 0], [2524, 1, 0],
      [2539, 0, 1], [2540, 1, 1],
    ],
  },
  palette: {
    background: 0x120f1c,
    noteColors: { todo: 0xe8d9a0, doing: 0x9fc4e8, blocked: 0xd9979b, done: 0xa3d4ae },
    // Same geometry as the office boards, dressed as a castle notice board:
    // dark oak instead of pine, parchment instead of cork, a wax seal instead of
    // a red month banner, candle gold instead of lilac on the ASK ME board.
    propStyle: {
      frame: 0x3d2b1f, surface: 0xd9c9a3, noteFallback: 0xefe4c6, pin: 0x2a1d14,
      pileBack: 0xd8caa6, pileFront: 0xefe4c6,
      page: 0xe8d9a0, banner: 0x7a1f2b, rings: 0xb59a5e, grid: 0xb9a679,
      table: 0x4a3526, tableShade: 0x33241a, doneEdge: 0x5f7a4f,
      askFrame: 0x2b2145, askAccent: 0xc9a84c, askWatermark: 0x8a7752,
    },
  },
  cast: {
    byName: WIZARD_CAST_BY_NAME,
    getFrames: (name: string) => getCastFrames(name as CharacterName),
    defaultCharacter: WIZARD_DEFAULT_CHARACTER,
  },
};

/** All registered themes. Phase 0 ships only the office; show themes register
 *  here as their content lands (Phase 2). */
export const THEMES: Partial<Record<ThemeId, ThemeConfig>> = {
  office: OFFICE_THEME,
  brooklyn99: BROOKLYN99_THEME,
  wizardschool: WIZARDSCHOOL_THEME,
};

/** Look up a theme by id, falling back to the office theme if unknown/missing
 *  (a bad/absent show bundle must never break the floor — see report §E). */
export function getTheme(id: ThemeId): ThemeConfig {
  return THEMES[id] ?? OFFICE_THEME;
}
