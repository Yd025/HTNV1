import type { CSSProperties } from "react";

export type HexColor = `#${string}`;

/** Source colors from the editorial references. Use semantic theme tokens in UI. */
export const palette = {
  ink: "#182232",
  rust: "#9C4135",
  sea: "#5B6670",
  slate: "#A4B0B7",
  charcoal: "#0F1318",
  chalk: "#E2E7EA",
  parchment: "#DCD9C8",
} as const satisfies Record<string, HexColor>;

export type ThemeId = "ink" | "archive" | "slate";

export interface ThemeColors {
  surface: HexColor;
  surfaceRaised: HexColor;
  surfaceMuted: HexColor;
  text: HexColor;
  textMuted: HexColor;
  textSubtle: HexColor;
  line: HexColor;
  lineStrong: HexColor;
  accent: HexColor;
  accentText: HexColor;
  accentContrast: HexColor;
  accentSoft: HexColor;
  canvas: HexColor;
  canvasGrid: HexColor;
  status: HexColor;
  warning: HexColor;
  focus: HexColor;
}

/** Solid Three.js material colors; kept separate from CSS custom properties. */
export interface ScenePalette {
  void: HexColor;
  surface: HexColor;
  surfaceEdge: HexColor;
  grid: HexColor;
  ink: HexColor;
  chalk: HexColor;
  rust: HexColor;
  muted: HexColor;
  background: HexColor;
  ground: HexColor;
  metal: HexColor;
  metalDark: HexColor;
  target: HexColor;
  truth: HexColor;
  coverage: HexColor;
  route: HexColor;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  colorScheme: "light" | "dark";
  colors: ThemeColors;
  swatches: readonly HexColor[];
  scene: ScenePalette;
}

function scenePalette(
  colors: Pick<
    ScenePalette,
    "void" | "surface" | "surfaceEdge" | "grid" | "muted"
  >,
): ScenePalette {
  return {
    ...colors,
    ink: palette.ink,
    chalk: palette.chalk,
    rust: palette.rust,
    background: colors.void,
    ground: colors.surface,
    metal: palette.slate,
    metalDark: palette.ink,
    target: palette.rust,
    truth: palette.sea,
    coverage: palette.sea,
    route: palette.rust,
  };
}

export const themes: Record<ThemeId, ThemeDefinition> = {
  ink: {
    id: "ink",
    name: "Ink & rust",
    description:
      "Deep navy, stone, and restrained rust. Closest to the reference.",
    colorScheme: "dark",
    swatches: [palette.ink, palette.rust, palette.slate, palette.chalk],
    colors: {
      surface: palette.ink,
      surfaceRaised: "#223044",
      surfaceMuted: "#131C29",
      text: palette.chalk,
      textMuted: palette.slate,
      textSubtle: "#95A2AE",
      line: "#354354",
      lineStrong: "#6D7D8E",
      accent: palette.rust,
      // The reference rust is a fill. This lighter tint is legible as small text.
      accentText: "#E3A295",
      accentContrast: palette.chalk,
      accentSoft: "#3E2B2F",
      canvas: palette.charcoal,
      canvasGrid: "#344454",
      status: "#B6C7B3",
      warning: "#DAB28D",
      focus: "#E3A295",
    },
    scene: scenePalette({
      void: palette.charcoal,
      surface: "#A4B0B7",
      surfaceEdge: "#465360",
      grid: "#667581",
      muted: palette.sea,
    }),
  },
  archive: {
    id: "archive",
    name: "Field archive",
    description:
      "Warm paper and brick red, inspired by the photographic archive.",
    colorScheme: "light",
    swatches: [palette.parchment, palette.rust, palette.ink, "#E9E6D9"],
    colors: {
      surface: palette.parchment,
      surfaceRaised: "#E9E6D9",
      surfaceMuted: "#CCC9B9",
      text: palette.ink,
      textMuted: "#4C534C",
      textSubtle: "#4C534C",
      line: "#B4B3A4",
      lineStrong: "#7C8075",
      accent: palette.rust,
      accentText: "#7F332A",
      accentContrast: palette.chalk,
      accentSoft: "#D8BCAD",
      canvas: "#C8C6B8",
      canvasGrid: "#969E95",
      status: "#405338",
      warning: "#694623",
      focus: "#7F332A",
    },
    scene: scenePalette({
      void: "#C8C6B8",
      surface: "#DCD9C8",
      surfaceEdge: "#939990",
      grid: "#A4AB9F",
      muted: "#697264",
    }),
  },
  slate: {
    id: "slate",
    name: "Cold slate",
    description: "Pale sea gray, ink typography, and rust contact markers.",
    colorScheme: "light",
    swatches: ["#CCD5D9", palette.ink, palette.rust, palette.chalk],
    colors: {
      surface: "#CCD5D9",
      surfaceRaised: palette.chalk,
      surfaceMuted: "#BCC7CE",
      text: palette.ink,
      textMuted: "#3F4D59",
      textSubtle: "#3F4D59",
      line: "#A5B2BC",
      lineStrong: "#778A99",
      accent: palette.rust,
      accentText: "#7F332A",
      accentContrast: palette.chalk,
      accentSoft: "#D8BCB5",
      canvas: "#BBC7CE",
      canvasGrid: "#8C9DA9",
      status: "#3D5348",
      warning: "#664522",
      focus: "#7F332A",
    },
    scene: scenePalette({
      void: "#BBC7CE",
      surface: "#D4DEE3",
      surfaceEdge: "#899CA9",
      grid: "#9EB0BE",
      muted: palette.sea,
    }),
  },
};

export const sceneColors: ScenePalette = themes.ink.scene;

type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

/** The whole application and its portals can share one typed semantic palette. */
export function themeStyle(theme: ThemeId | ThemeDefinition): ThemeStyle {
  const definition = typeof theme === "string" ? themes[theme] : theme;
  const style: ThemeStyle = { colorScheme: definition.colorScheme };
  for (const [name, value] of Object.entries(definition.colors)) {
    const cssName = name.replace(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    );
    style[`--${cssName}`] = value;
  }
  return style;
}
