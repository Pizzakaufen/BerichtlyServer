// Berichtly Web – Effekte aus Libraries.dev ohne React (MIT, © 2026 Jakub Antalik).
//
// thinkingOrb(): Vanilla-Gegenstück zu ThinkingOrb.tsx. Nutzt die unveränderte Geometrie aus
//   vendor/thinking-orbs (resolvePreset + MODE_FRAMES + paintFrame) und übernimmt das Verhalten des Originals:
//   DPR höchstens 2, ein stehendes Bild bei reduzierter Bewegung (t = 0,6), Pause außerhalb des sichtbaren Bereichs,
//   role="img" mit Beschriftung, Hell/Dunkel über data-theme bzw. prefers-color-scheme.
// borderBeam(): Vanilla-Gegenstück zu BorderBeam.tsx (Typen sm/md/line). Die CSS-Regeln erzeugt unverändert
//   generateBeamCSS() aus vendor/border-beam; eingebunden als Constructable Stylesheet (kompatibel mit
//   style-src 'self'), Aktivierung über data-active/data-fading wie im Original.
//
// Berichtly-Regel: Animiert wird nur, was tatsächlich gerade passiert (Anfrage läuft, Speichern läuft …).

import { resolvePreset } from './vendor/thinking-orbs/presets.js';
import { MODE_FRAMES } from './vendor/thinking-orbs/engine/registry.js';
import { paintFrame } from './vendor/thinking-orbs/engine/core.js';
import { generateBeamCSS, sizePresets, sizeThemePresets } from './vendor/border-beam/styles.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

const LABELS = {
  working: 'Arbeitet', searching: 'Sucht', solving: 'Löst', listening: 'Hört zu', connecting: 'Verbindet',
  weaving: 'Verknüpft', composing: 'Formuliert', breathing: 'Bereit', shaping: 'Formt',
};

/**
 * Erzeugt einen Orb. `animate: false` zeigt ein stehendes Bild (Ruhezustand).
 * Rückgabe: { el, set(state, animate), destroy() }.
 */
export function thinkingOrb({ state = 'breathing', size = 32, animate = false, label } = {}) {
  const el = document.createElement('canvas');
  el.className = 'orb';
  el.setAttribute('role', 'img');
  const preset = size >= 48 ? 64 : size >= 26 ? 32 : 20;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.width = size * dpr;
  el.height = size * dpr;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  const ctx = el.getContext('2d');
  let current = { state, animate };
  let raf = 0;
  let visible = true;
  const t0 = performance.now();

  const draw = (t) => {
    const { mode, opts } = resolvePreset(current.state, preset);
    ctx.setTransform(dpr * (size / preset), 0, 0, dpr * (size / preset), 0, 0);
    ctx.clearRect(0, 0, preset, preset);
    paintFrame(ctx, MODE_FRAMES[mode](preset, t, opts), isDark());
  };
  const loop = () => {
    const { speed } = resolvePreset(current.state, preset);
    draw(((performance.now() - t0) / 1000) * speed + 0.6);
    raf = requestAnimationFrame(loop);
  };
  const restart = () => {
    cancelAnimationFrame(raf);
    el.setAttribute('aria-label', label ?? LABELS[current.state] ?? '');
    if (current.animate && visible && !reducedMotion()) raf = requestAnimationFrame(loop);
    else draw(0.6);
  };
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    restart();
  });
  io.observe(el);
  const themeWatch = new MutationObserver(restart);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  restart();
  return {
    el,
    set(state, animate) {
      current = { state, animate };
      restart();
    },
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      themeWatch.disconnect();
    },
  };
}

let beamCounter = 0;

/**
 * Legt einen Lichtstrahl um `host` (Element mit border-radius). `active` schaltet ihn ein/aus (mit Ausblenden).
 * Rückgabe: { setActive(bool), destroy() }.
 */
export function borderBeam(host, { size = 'md', colorVariant = 'ocean', strength = 1, duration } = {}) {
  const id = `bb-${++beamCounter}`;
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const bloom = document.createElement('div');
  bloom.setAttribute('data-beam-bloom', '');
  bloom.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-beam', id);
  host.style.setProperty('--beam-strength', String(Math.max(0, Math.min(1, strength))));
  host.append(bloom);

  const render = () => {
    const theme = isDark() ? 'dark' : 'light';
    const t = sizeThemePresets[size][theme];
    const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || sizePresets[size].borderRadius;
    sheet.replaceSync(generateBeamCSS({
      id, borderRadius: radius, borderWidth: sizePresets[size].borderWidth,
      duration: duration ?? (size === 'line' ? 3.1 : 1.96),
      strokeOpacity: t.strokeOpacity, innerOpacity: t.innerOpacity, bloomOpacity: t.bloomOpacity, innerShadow: t.innerShadow,
      size, colorVariant, staticColors: colorVariant === 'mono' || reducedMotion(),
      brightness: t.brightness ?? 1.3, saturation: t.saturation, hueRange: size === 'line' ? 13 : 30,
      theme, hairlineOpacity: t.hairlineOpacity, glowSize: 1,
    }));
  };
  render();
  const themeWatch = new MutationObserver(render);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const onEnd = (e) => {
    if (String(e.animationName).includes('fade-out')) host.removeAttribute('data-fading');
  };
  host.addEventListener('animationend', onEnd);

  return {
    setActive(on) {
      if (on) {
        host.removeAttribute('data-fading');
        host.setAttribute('data-active', '');
      } else if (host.hasAttribute('data-active')) {
        host.removeAttribute('data-active');
        host.setAttribute('data-fading', '');
        // Ohne Animationen (reduzierte Bewegung) endet das Ausblenden sofort.
        if (reducedMotion()) host.removeAttribute('data-fading');
      }
    },
    destroy() {
      themeWatch.disconnect();
      host.removeEventListener('animationend', onEnd);
      bloom.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    },
  };
}
