// Theme loader — resolves a ThemeConfig into a ready-to-render map.
//
// Phase 0 keeps this thin: it parses the theme's Tiled JSON and patches the
// appended tileset atlases with their inline metadata (the same patch the
// office scene did inline as resolveMap()). The async `loadTheme` signature is
// deliberate headroom for later phases, where a show bundle may be fetched and
// validated before it's handed to the scene; on any failure it falls back to
// the office theme so a bad/absent bundle never breaks the floor (report §E).

import type { TiledMap } from './TiledMapRenderer';
import {
  getTheme,
  OFFICE_THEME,
  type ThemeConfig,
  type ThemeId,
} from './themeRegistry';

/** Parse a theme's raw Tiled JSON and patch its tileset array.
 *  `embedded` atlases keep the map's own inline metadata; the rest are replaced
 *  by the theme's inline metadata (firstgid + image dimensions). The result's
 *  tileset order matches the texture-load order (texture[i] ↔ tilesets[i]). */
export function resolveThemeMap(theme: ThemeConfig): TiledMap {
  const m = JSON.parse(theme.mapRaw) as TiledMap;
  return {
    ...m,
    tilesets: theme.tilesets.map((t, i) => {
      if (t.embedded) return m.tilesets[i];
      // Strip the renderer-only fields (url/embedded); the rest is Tiled metadata.
      const { url: _url, embedded: _embedded, ...meta } = t;
      return meta as TiledMap['tilesets'][number];
    }),
  };
}

/** The ordered tileset image URLs to load as textures, matching the map's
 *  tileset order (so texture[i] lines up with tilesets[i]). */
export function themeTilesetUrls(theme: ThemeConfig): string[] {
  return theme.tilesets.map((t) => t.url);
}

/** Theme ids that were renamed after they could already be persisted. The
 *  Wizarding School shipped as `hogwarts` while it was still `built: false`, and
 *  the picker persists an unbuilt id on switch, so a saved config can still name
 *  it. Without this the stored value falls through to the office and the user
 *  silently loses the theme they picked. */
const LEGACY_THEME_IDS: Record<string, ThemeId> = { hogwarts: 'wizardschool' };

/** Map a persisted (possibly renamed) id onto a current ThemeId. */
export function resolveThemeId(id: string): ThemeId {
  return LEGACY_THEME_IDS[id] ?? (id as ThemeId);
}

/** Light validation: the theme's map must parse and carry sane dimensions. */
function isThemeRenderable(theme: ThemeConfig): boolean {
  try {
    const m = JSON.parse(theme.mapRaw) as TiledMap;
    return (
      typeof m.width === 'number' && m.width > 0 &&
      typeof m.height === 'number' && m.height > 0 &&
      Array.isArray(m.layers) && Array.isArray(m.tilesets)
    );
  } catch {
    return false;
  }
}

/** Resolve a theme id to a renderable ThemeConfig. Async by design (later
 *  phases may fetch a show bundle here); falls back to the office theme if the
 *  requested theme is missing or its map won't parse. */
export async function loadTheme(id: ThemeId): Promise<ThemeConfig> {
  const theme = getTheme(resolveThemeId(id));
  if (!isThemeRenderable(theme)) {
    console.warn(`[themeLoader] theme '${id}' is not renderable — falling back to 'office'`);
    return OFFICE_THEME;
  }
  return theme;
}
