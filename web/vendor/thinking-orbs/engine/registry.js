// Aus Libraries.dev (thinking-orbs, MIT) – nur Typen entfernt, siehe scripts/vendor-libraries.mjs.
// Mode key → geometry builder. Kept separate from the presets so tree
// shaking can in principle drop unused modes in custom builds.

                                          
                                                   
import { paintFrame } from './core.js';
import { frameBraid } from './braid.js';
import { frameGlobe, frameRubik, frameWave } from './lattice.js';
import { frameMorph } from './morph.js';
import { frameOrbits } from './orbits.js';
import { frameRibbon } from './ribbon.js';
import { frameWeb } from './web.js';

/**
 * The portable surface: pure geometry, no canvas. The React Native port
 * imports exactly these functions, so its output is identical to the web's
 * by construction rather than by re-implementation.
 */
export const MODE_FRAMES                             = {
  orbits: frameOrbits,
  globe: frameGlobe,
  rubik: frameRubik,
  wave: frameWave,
  web: frameWeb,
  braid: frameBraid,
  ribbon: frameRibbon,
  // ring shares ribbon's geometry — the `faceOn` profile flag switches it
  ring: frameRibbon,
  morph: frameMorph
};

/** Canvas painters, derived from the geometry. The 2D-canvas binding. */
export const MODE_DRAWS                            = Object.fromEntries(
  Object.entries(MODE_FRAMES).map(([key, frame]) => [
    key,
    ((ctx, size, t, dark, opts) => paintFrame(ctx, frame(size, t, opts), dark))            
  ])
)                             ;
