/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  type Oklch,
  parseAccentColor,
} from "../features/theme/contrast";

/**
 * The Tron theme's contrast, measured from the stylesheet itself so the numbers
 * cannot drift from what ships (docs/features/pwa.md is not the place for this;
 * DESIGN.md requires AA for new foreground/background pairs in both themes).
 */

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    tokens[match[1] as string] = (match[2] as string).trim();
  }
  return tokens;
}

// Read from disk: Vitest blanks every `.css` import, `?raw` included.
const css = readFileSync(resolve(process.cwd(), "src/styles/tron.css"), "utf8");

const modes = { light: block(":root"), dark: block(".dark") } as const;

function color(mode: keyof typeof modes, token: string): Oklch {
  const value = modes[mode][`--${token}`];
  const parsed = value ? parseAccentColor(value) : null;
  if (!parsed) throw new Error(`${mode} ${token} is not a measurable colour`);
  return parsed;
}

/** [text token, surface token, minimum ratio, what it is] */
const PAIRS: Array<[string, string, number, string]> = [
  ["foreground", "background", 4.5, "body text on the page"],
  ["foreground", "card", 4.5, "body text on content"],
  ["card-foreground", "card", 4.5, "card text"],
  ["popover-foreground", "popover", 4.5, "menu text"],
  ["foreground", "muted", 4.5, "text on a hovered row"],
  ["foreground", "accent", 4.5, "text on a selected row"],
  ["foreground", "secondary", 4.5, "text on a secondary control"],
  ["secondary-foreground", "secondary", 4.5, "secondary button text"],
  ["muted-foreground", "background", 4.5, "metadata on the page"],
  ["muted-foreground", "card", 4.5, "metadata on content"],
  ["muted-foreground", "muted", 4.5, "metadata on a hovered row"],
  ["muted-foreground", "accent", 4.5, "metadata on a selected row"],
  ["primary-foreground", "primary", 4.5, "primary button text"],
  ["brand-foreground", "brand", 4.5, "brand button text"],
  ["brand", "background", 4.5, "links on the page"],
  ["brand", "card", 4.5, "links on content"],
  ["destructive", "background", 4.5, "danger text on the page"],
  ["destructive", "card", 4.5, "danger text on content"],
  ["destructive-foreground", "destructive", 4.5, "destructive button text"],
  ["success", "background", 4.5, "saved/success notices"],
  ["sidebar-foreground", "sidebar", 4.5, "navigation text"],
  ["sidebar-accent-foreground", "sidebar-accent", 4.5, "selected navigation"],
  ["muted-foreground", "sidebar", 4.5, "navigation metadata"],
  ["sidebar-primary-foreground", "sidebar-primary", 4.5, "navigation primary"],
  // Not text: the focus ring must be visible against the page (WCAG 1.4.11).
  ["ring-source", "background", 3, "focus ring"],
];

describe.each(Object.keys(modes) as Array<keyof typeof modes>)(
  "%s mode",
  (mode) => {
    it.each(PAIRS)(
      "%s on %s is at least %s:1 (%s)",
      (text, surface, minimum) => {
        const textToken = text === "ring-source" ? "brand" : text;
        const ratio = contrastRatio(
          color(mode, textToken),
          color(mode, surface),
        );
        expect(ratio).toBeGreaterThanOrEqual(minimum);
      },
    );

    it("keeps borders visible against chrome (never zero-contrast)", () => {
      const against = mode === "dark" ? "muted" : "background";
      expect(
        contrastRatio(color(mode, "border"), color(mode, against)),
      ).toBeGreaterThan(1.1);
    });
  },
);

describe("theme shape", () => {
  it("defines every token in both modes that it defines in one", () => {
    const light = new Set(
      Object.keys(modes.light).filter((k) => !k.startsWith("--glow")),
    );
    const dark = new Set(
      Object.keys(modes.dark).filter((k) => !k.startsWith("--glow")),
    );
    for (const token of dark)
      expect(light.has(token), `${token} missing in light`).toBe(true);
    for (const token of light)
      if (token !== "--font-display")
        expect(dark.has(token), `${token} missing in dark`).toBe(true);
  });

  it("only glows in dark", () => {
    expect(modes.light["--glow-soft"]).toMatch(/transparent/);
    expect(modes.dark["--glow-soft"]).toMatch(/brand/);
  });
});
