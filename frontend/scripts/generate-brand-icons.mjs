/**
 * Generates every raster icon from the one master image, brand/trapper-keeper-icon.png.
 *
 *   npm run pwa:assets
 *
 * The master lives outside public/ on purpose: it is 1024px and is not needed at
 * runtime, and anything under public/ is precached for every install. Outputs:
 *
 *   public/pwa-192x192.png, public/pwa-512x512.png   manifest `any` icons, also
 *                                                    used by <BrandMark> in the UI
 *   public/pwa/maskable-icon-{192,512}x....png       manifest `maskable` icons
 *   public/apple-touch-icon.png                      iOS home screen (180px)
 *   public/favicon.ico                               16, 32 and 48px
 *
 * The master is full-bleed art with no transparency, so the same image serves as
 * the maskable source: a platform mask only trims the corners, and the artwork's
 * subject sits in the middle. Uses `sharp` and `sharp-ico`, which come with
 * @vite-pwa/assets-generator.
 */
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { sharpsToIco } from "sharp-ico";

const MASTER = new URL("../brand/trapper-keeper-icon.png", import.meta.url);
const pub = (path) => new URL(`../public/${path}`, import.meta.url).pathname;

const source = () => sharp(MASTER.pathname).flatten({ background: "#000000" });
const png = (size, out) =>
  source()
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toFile(out);

await mkdir(pub("pwa"), { recursive: true });
await Promise.all([
  png(192, pub("pwa-192x192.png")),
  png(512, pub("pwa-512x512.png")),
  png(192, pub("pwa/maskable-icon-192x192.png")),
  png(512, pub("pwa/maskable-icon-512x512.png")),
  png(180, pub("apple-touch-icon.png")),
]);
await sharpsToIco(
  [16, 32, 48].map((size) => source().resize(size, size, { fit: "cover" })),
  pub("favicon.ico"),
);
console.log("Brand icons generated from brand/trapper-keeper-icon.png");
