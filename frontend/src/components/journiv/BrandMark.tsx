import { cx } from "../../lib/cx";

/** The icon the whole product shares: the same file the installed app, the
 *  favicon and the home-screen icon are generated from (brand/ and
 *  scripts/generate-brand-icons.mjs). */
const MARK_SRC = "/pwa-192x192.png";

/**
 * The Trapper Keeper identity mark: the app icon, shown as a rounded square.
 *
 * The mark is fixed brand identity, not chrome: it is an image, so it does not
 * follow the theme or a user's accent personalization -- `--brand` in
 * `tokens.css` is the *customisable* UI accent and must never colour the logo
 * (DESIGN.md, "The identity mark"). The same artwork ships as
 * `public/favicon.ico`, `public/apple-touch-icon.png` and the PWA icons.
 *
 * Accessibility: the mark is decorative (`alt=""`) by default -- pair it with
 * visible text that names it. `wordmark` renders that text ("Trapper Keeper")
 * itself. When the mark stands alone (no adjacent brand text), pass `title`
 * so it exposes an accessible name instead of vanishing from the a11y tree.
 */
export function BrandMark({
  size = 28,
  wordmark = false,
  title,
  className,
}: {
  /** Edge length in px. */
  size?: number;
  /** Render the mark followed by the "Trapper Keeper" wordmark as one lockup. */
  wordmark?: boolean;
  /** Accessible name for a standalone mark. Ignored when `wordmark` is set
   *  (the visible text carries the name then). */
  title?: string;
  className?: string;
}) {
  const labelled = !wordmark && Boolean(title);
  const mark = (
    <img
      className="jv-brand-mark"
      src={MARK_SRC}
      width={size}
      height={size}
      alt={labelled ? title : ""}
      aria-hidden={labelled ? undefined : true}
      decoding="async"
      draggable={false}
    />
  );

  if (!wordmark) return <span className={className}>{mark}</span>;

  return (
    <span className={cx("jv-brand-lockup", className)}>
      {mark}
      <span className="jv-brand-lockup__text">Trapper Keeper</span>
    </span>
  );
}
