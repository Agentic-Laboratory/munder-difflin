// The Office cast — roster metadata + sprite frames.
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type OfficeCharacterName =
  | 'michael' | 'jim' | 'pam' | 'dwight' | 'kevin' | 'angela'
  | 'oscar' | 'stanley' | 'phyllis' | 'andy' | 'kelly' | 'ryan'
  | 'toby' | 'creed' | 'meredith';

/** The Wizarding School roster. The internal ids below (`sable`, `ashcroft`,
 *  etc.) stay generic — they're stored in live user data and must never be
 *  renamed. The DISPLAY names shown to the user are the actual Harry Potter
 *  cast (Dumbledore, McGonagall, Harry, ...) and the houses are the real
 *  Gryffindor / Slytherin / Ravenclaw / Hufflepuff. This is a personal/local
 *  labelling choice, not a claim that the ids themselves mean anything. */
export type WizardCharacterName =
  | 'sable' | 'ashcroft' | 'bane' | 'bramble' | 'thorne'
  | 'quill' | 'rowan' | 'cassius' | 'lark' | 'barnaby';

/** Any character in any theme. An agent keeps its character across a theme
 *  switch, so every lookup that resolves a stored value must accept the union —
 *  only the Add-Agent picker narrows to the active theme's roster. */
export type CharacterName = OfficeCharacterName | WizardCharacterName;

export interface CastMember {
  name: CharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
}

/** Selectable roster, in display order. */
export const OFFICE_CAST: CastMember[] = [
  { name: 'michael',  displayName: 'Michael',  shirt: '#5a6b8c', blurb: "World's best boss" },
  { name: 'jim',      displayName: 'Jim',      shirt: '#6fa8dc', blurb: 'Salesman, prankster' },
  { name: 'pam',      displayName: 'Pam',      shirt: '#9caf88', blurb: 'Receptionist, artist' },
  { name: 'dwight',   displayName: 'Dwight',   shirt: '#b89b3e', blurb: 'Assistant (to the) RM' },
  { name: 'kevin',    displayName: 'Kevin',    shirt: '#4a7ab5', blurb: 'Accounting' },
  { name: 'angela',   displayName: 'Angela',   shirt: '#8a86a6', blurb: 'Head of accounting' },
  { name: 'oscar',    displayName: 'Oscar',    shirt: '#7a4b6b', blurb: 'Accountant' },
  { name: 'stanley',  displayName: 'Stanley',  shirt: '#8c5a4b', blurb: 'Sales, crossword' },
  { name: 'phyllis',  displayName: 'Phyllis',  shirt: '#b08bbf', blurb: 'Sales' },
  { name: 'andy',     displayName: 'Andy',     shirt: '#6fae6f', blurb: 'Cornell, a cappella' },
  { name: 'kelly',    displayName: 'Kelly',    shirt: '#d16ba5', blurb: 'Customer service' },
  { name: 'ryan',     displayName: 'Ryan',     shirt: '#3a3a44', blurb: 'The temp' },
  { name: 'toby',     displayName: 'Toby',     shirt: '#9a8c5a', blurb: 'Human resources' },
  { name: 'creed',    displayName: 'Creed',    shirt: '#6b7a4b', blurb: 'Quality assurance' },
  { name: 'meredith', displayName: 'Meredith', shirt: '#b5544a', blurb: 'Supplier relations' },
];

/** Wizarding School cast. `shirt` is the in-scene selection glow — house colour
 *  for students, robe colour for staff. */
export const WIZARD_CAST: CastMember[] = [
  { name: 'sable',    displayName: 'Dumbledore', shirt: '#5a6bb0', blurb: 'Headmaster' },
  { name: 'ashcroft', displayName: 'McGonagall', shirt: '#3a8a62', blurb: 'Deputy head, transfiguration' },
  { name: 'bane',     displayName: 'Snape',      shirt: '#4a4658', blurb: 'Potions master' },
  { name: 'bramble',  displayName: 'Hagrid',     shirt: '#8a6440', blurb: 'Groundskeeper' },
  { name: 'thorne',   displayName: 'Harry',      shirt: '#8a222c', blurb: 'Gryffindor, the boy who lived' },
  { name: 'quill',    displayName: 'Hermione',   shirt: '#a8323c', blurb: 'Gryffindor, top of the class' },
  { name: 'rowan',    displayName: 'Ron',        shirt: '#c2603a', blurb: 'Gryffindor, loyal to a fault' },
  { name: 'cassius',  displayName: 'Draco',      shirt: '#1e563a', blurb: 'Slytherin, and never lets you forget' },
  { name: 'lark',     displayName: 'Luna',       shirt: '#2a427c', blurb: 'Ravenclaw, elsewhere mostly' },
  { name: 'barnaby',  displayName: 'Neville',    shirt: '#8f2f38', blurb: 'Gryffindor, herbology' },
];

/** Every character across every theme. Use this to RESOLVE a stored character —
 *  an agent hired under one theme must still resolve after a switch. Use
 *  `castForTheme` for the picker, which should only OFFER the active roster. */
export const ALL_CAST: CastMember[] = [...OFFICE_CAST, ...WIZARD_CAST];

export const CAST_BY_NAME: Record<CharacterName, CastMember> =
  Object.fromEntries(ALL_CAST.map((c) => [c.name, c])) as Record<CharacterName, CastMember>;

export const OFFICE_CAST_BY_NAME: Record<string, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c]));

export const WIZARD_CAST_BY_NAME: Record<string, CastMember> =
  Object.fromEntries(WIZARD_CAST.map((c) => [c.name, c]));

export const DEFAULT_CHARACTER: CharacterName = 'jim';
export const WIZARD_DEFAULT_CHARACTER: CharacterName = 'thorne';

/** Which roster each theme OFFERS, keyed by ThemeId. Not typed as ThemeId and
 *  not imported from themeRegistry, because themeRegistry imports this module —
 *  one table keeps the theme id to a single occurrence here. Themes absent from
 *  the table (brooklyn99, and the unbuilt ones) correctly get the office cast,
 *  which is what their ThemeConfig reuses. */
const ROSTERS: Record<string, {
  cast: CastMember[];
  defaultCharacter: CharacterName;
  /** Who the ORCHESTRATOR is in this theme — the boss, the headmaster. Every
   *  other agent carries its character in the roster file, but god's PTY never
   *  survives a restart, so useHive drops god from the roster and rebuilds its
   *  entry from scratch on each launch. That rebuild has nothing to read but
   *  this table, which is why the one agent the app creates itself is the one
   *  whose identity has to live in code. */
  god: CharacterName;
}> = {
  office: { cast: OFFICE_CAST, defaultCharacter: DEFAULT_CHARACTER, god: 'michael' },
  wizardschool: { cast: WIZARD_CAST, defaultCharacter: WIZARD_DEFAULT_CHARACTER, god: 'sable' },
};

/** The roster the Add-Agent picker should OFFER for a theme. Keeping this
 *  separate from ALL_CAST is what stops wizarding characters appearing in every
 *  user's picker while the experimental flag is off. */
export function castForTheme(theme?: string): CastMember[] {
  return ROSTERS[theme ?? 'office']?.cast ?? OFFICE_CAST;
}

/** The default character for a theme's roster. */
export function defaultCharacterForTheme(theme?: string): CharacterName {
  return ROSTERS[theme ?? 'office']?.defaultCharacter ?? DEFAULT_CHARACTER;
}

/** The orchestrator's identity for a theme — both its character and the display
 *  name shown on its card, its terminal tab and its /remote-control session.
 *
 *  Takes the raw `officeTheme` config value and falls back to the office for an
 *  unknown one, exactly as `castForTheme` and `defaultCharacterForTheme` do — an
 *  unregistered theme id already resolves to the office everywhere else (see
 *  `getTheme`), so god must not be the one place that disagrees. */
export function godForTheme(theme?: string): CastMember {
  const name = ROSTERS[theme ?? 'office']?.god ?? ROSTERS.office.god;
  return CAST_BY_NAME[name];
}

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<CharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. We provide a front view
 * (down — and reused for the side row, so left/right walkers still show a face)
 * and a back view (up — agents seated facing their desk show their back). The
 * three walk frames are stand / step-left / step-right.
 */
export async function getCastFrames(name: CharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = sceneFrameBufs(name);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/**
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: CharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}
