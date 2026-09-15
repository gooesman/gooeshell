/** Keep GPU glyph coordinates private to a terminal while sharing loaded fonts.
 * xterm's WebGL atlas cache uses the entire family string as its identity. The
 * final nonexistent family is after the generic fallback, so it never changes
 * font selection but prevents one terminal clearing another terminal's atlas.
 */
export function scopedTerminalFontFamily(family: string, scope: string): string {
  return `${family}, ${JSON.stringify(`gooeshell-atlas-${scope}`)}`;
}
