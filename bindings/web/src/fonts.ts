import { FONT_FILES } from '@schaefchens/scriptura';

/**
 * Adds the reader's fonts per script to the page, from where the import tool put them: each as
 * `${family}.ttf` under `base`. A font loads once the page first sets text in it.
 */
export function addScriptFonts(base: string | URL) {
  for (const { family } of FONT_FILES) {
    if ([...document.fonts].some((face) => face.family === family || face.family === `"${family}"`)) continue;
    document.fonts.add(new FontFace(family, `url(${new URL(`${family}.ttf`, new URL(base, location.href))})`));
  }
}
