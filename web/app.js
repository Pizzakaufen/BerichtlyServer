// Berichtly Web 2.2 – Weboberfläche für Konten auf diesem Berichtly Server.
//
// Ohne Framework und ohne Build-Schritt: ES-Module, DOM-Aufbau über h(), keine innerHTML-Zuweisung von Daten.
// Daten kommen ausschließlich über die bestehende API /api/v1 (Anmeldung, Wochen, Tages- und Wochenberichte,
// Profil, Geräte, Datenexport). Änderungen landen als gewöhnliche Serveränderungen und erreichen die Android-App
// über die vorhandene Synchronisierung (Versionen, Konflikterkennung).
// Ehrlich: Die KI und die PDF-Erzeugung der App laufen nur auf dem Gerät. Das Web zeigt deshalb keinen
// KI-Assistenten, der etwas vortäuscht; das PDF entsteht hier über den Druckdialog des Browsers.

import { thinkingOrb, borderBeam } from './fx.js';

// --- Hilfen -----------------------------------------------------------------------------------------------------

const API = '/api/v1';
const root = document.getElementById('root');
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* privat */ } },
};
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat */ } },
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  doc: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6',
  cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  tools: 'M14 6l4 4M3 21l7-7M13 3l8 8-4 4-8-8z',
  ai: 'M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z',
  pdf: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 14h2a1.5 1.5 0 0 0 0-3H9v6',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14.6H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l4 4 10-10',
  warn: 'M12 4l9 16H3zM12 10v4M12 17v.5',
  err: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16v.5',
  draft: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  sync: 'M4 12a8 8 0 0 1 14-5l2-2v6h-6l2.3-2.3A6 6 0 0 0 6 12M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2.3 2.3A6 6 0 0 0 18 12',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  print: 'M7 9V3h10v6M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v7H7z',
  admin: 'M4 6h16M4 12h16M4 18h10',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] ?? ICONS.draft);
  svg.append(p);
  return svg;
}

const STATUS = {
  DRAFT: { label: 'Entwurf', cls: 'neutral', icon: 'draft' },
  GENERATED: { label: 'KI-Entwurf', cls: 'neutral', icon: 'ai' },
  EDITED: { label: 'In Bearbeitung', cls: 'run', icon: 'edit' },
  FINALIZED: { label: 'Fertig', cls: 'ok', icon: 'check' },
  REVIEW_REQUIRED: { label: 'Prüfung erforderlich', cls: 'warn', icon: 'warn' },
  APPROVED: { label: 'Freigegeben', cls: 'ok', icon: 'shield' },
};
const badge = (status) => {
  const s = STATUS[status] ?? STATUS.DRAFT;
  return h('span', { class: `badge ${s.cls}` }, icon(s.icon), s.label);
};

// Datumsfunktionen (ISO-Wochen, Montag–Sonntag) – lokal, ohne Zeitzonenumrechnung.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}
const fmt = {
  day: new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }),
  long: new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }),
  date: new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  month: new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }),
  time: new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
};
const when = (ts) => (ts ? fmt.time.format(new Date(ts)) : '–');

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// --- API --------------------------------------------------------------------------------------------------------

class ApiFailure extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Fehler ${status}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

let refreshing = null;
async function refresh() {
  const token = store.get('refresh');
  if (!token) return false;
  refreshing ??= fetch(`${API}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: token }),
  }).then(async (r) => {
    if (!r.ok) return false;
    const { data } = await r.json();
    store.set('access', data.accessToken);
    store.set('refresh', data.refreshToken);
    return true;
  }).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

async function api(method, path, body, retry = true) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(store.get('access') ? { Authorization: `Bearer ${store.get('access')}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && (await refresh())) return api(method, path, body, false);
  if (res.status === 401) { signOutLocal(); throw new ApiFailure(401, { error: { message: 'Bitte erneut anmelden.' } }); }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(res.status, json);
  return json;
}

function deviceInfo() {
  let id = prefs.get('deviceId');
  if (!id) { id = crypto.randomUUID(); prefs.set('deviceId', id); }
  const ua = navigator.userAgentData?.platform ?? navigator.platform ?? 'Browser';
  return { id, name: 'Web-Browser', platform: 'WEB', osVersion: String(ua).slice(0, 32), appVersion: 'web-2.2' };
}

function signOutLocal() {
  store.set('access', null);
  store.set('refresh', null);
  if (location.hash !== '#/anmelden') location.hash = '#/anmelden';
}

// --- Theme ------------------------------------------------------------------------------------------------------

function applyTheme(mode = prefs.get('theme') ?? 'system') {
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}
applyTheme();

// --- Gerüst -----------------------------------------------------------------------------------------------------

const ROUTES = [
  { path: 'start', label: 'Start', icon: 'home', view: viewStart },
  { path: 'berichte', label: 'Berichte', icon: 'doc', view: viewReports },
  { path: 'kalender', label: 'Kalender', icon: 'cal', view: viewCalendar },
  { path: 'pdf', label: 'PDF Studio', icon: 'pdf', view: viewPdf },
  { path: 'ki', label: 'KI-Assistent', icon: 'ai', view: viewAi },
  { path: 'einstellungen', label: 'Einstellungen', icon: 'gear', view: viewSettings },
];
const MOBILE = ['start', 'berichte', 'kalender', 'pdf', 'einstellungen'];

let cleanups = [];
function onLeave(fn) { cleanups.push(fn); }

function shell(active, content) {
  const link = (r, cls) => h('a', { href: `#/${r.path}`, class: cls, 'aria-current': r.path === active ? 'page' : null }, icon(r.icon), h('span', { class: 'label' }, r.label));
  return h('div', { class: 'shell' },
    h('nav', { class: 'sidebar', 'aria-label': 'Hauptnavigation' },
      h('div', { class: 'brand' }, h('span', { class: 'label' }, 'Berichtly')),
      h('div', { class: 'nav' }, ROUTES.map((r) => link(r))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'foot nav' },
        h('a', { href: '/admin' }, icon('admin'), h('span', { class: 'label' }, 'Administration')),
        h('a', { href: '#/abmelden' }, icon('logout'), h('span', { class: 'label' }, 'Abmelden')))),
    h('main', { id: 'main', tabindex: '-1' }, content),
    h('nav', { class: 'tabbar', 'aria-label': 'Hauptnavigation' }, ROUTES.filter((r) => MOBILE.includes(r.path)).map((r) =>
      h('a', { href: `#/${r.path}`, 'aria-current': r.path === active ? 'page' : null }, icon(r.icon), r.label === 'Einstellungen' ? 'Mehr' : r.label))));
}

function loading(label = 'Wird geladen') {
  const orb = thinkingOrb({ state: 'working', size: 32, animate: true, label });
  onLeave(() => orb.destroy());
  return h('div', { class: 'empty', role: 'status' }, orb.el, h('p', {}, `${label} …`));
}

function failure(err, retry) {
  return h('div', { class: 'notice err', role: 'alert' }, icon('err'),
    h('div', {}, h('p', {}, err.message || 'Das hat leider nicht funktioniert.'), retry ? h('button', { class: 'btn ghost', onclick: retry }, 'Erneut versuchen') : null));
}

async function route() {
  cleanups.forEach((f) => f());
  cleanups = [];
  const [, path = 'start', ...rest] = location.hash.split('/');
  if (path === 'abmelden') {
    try { await api('POST', '/auth/logout'); } catch { /* bereits abgemeldet */ }
    signOutLocal();
    return;
  }
  if (!store.get('access') || path === 'anmelden') return viewLogin();
  const r = ROUTES.find((x) => x.path === path) ?? (path === 'woche' ? { path: 'berichte', view: viewWeek } : ROUTES[0]);
  const body = h('div', { class: 'page' });
  root.replaceChildren(shell(r.path, body));
  document.getElementById('main').focus({ preventScroll: true });
  body.append(loading());
  try {
    const out = await r.view(...rest);
    body.replaceChildren(...[out].flat().filter((x) => x != null && x !== false));
  } catch (e) {
    body.replaceChildren(failure(e, route));
  }
}
addEventListener('hashchange', route);

// --- Anmelden ---------------------------------------------------------------------------------------------------

function viewLogin() {
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { class: 'input', id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary wide', type: 'submit' }, 'Anmelden');
  const panel = h('form', { class: 'panel beam-host', novalidate: true },
    h('div', { class: 'page-head' }, h('p', { class: 'eyebrow' }, 'Berichtly Server'), h('h1', {}, 'Anmelden')),
    h('p', { class: 'muted small' }, 'Mit demselben Konto wie in der Android-App. Deine Berichte bleiben auf diesem Server und deinen Geräten.'),
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'E-Mail-Adresse'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Passwort'), password),
    error, submit);
  const beam = borderBeam(panel, { size: 'md', colorVariant: 'ocean', strength: 0.9 });
  onLeave(() => beam.destroy());
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!email.value.trim() || !password.value) { error.textContent = 'Bitte E-Mail-Adresse und Passwort eingeben.'; return; }
    submit.disabled = true;
    beam.setActive(true); // echter Vorgang: die Anmeldung läuft
    try {
      const { data } = await api('POST', '/auth/login', { email: email.value.trim(), password: password.value, device: deviceInfo() }, false);
      store.set('access', data.accessToken);
      store.set('refresh', data.refreshToken);
      location.hash = '#/start';
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
      beam.setActive(false);
    }
  });
  root.replaceChildren(h('main', { id: 'main', class: 'login' }, panel));
  email.focus();
}

// --- Start ------------------------------------------------------------------------------------------------------

async function viewStart() {
  const [week, profile, recentDaily, recentWeekly, devices] = await Promise.all([
    api('GET', '/weeks/current'), api('GET', '/profile'), api('GET', '/daily-reports?limit=5'),
    api('GET', '/weekly-reports?limit=3'), api('GET', '/devices').catch(() => ({ data: [] })),
  ]);
  const w = week.data;
  const today = w.today;
  const first = (profile.data.name || '').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';
  const workdays = w.days.slice(0, 5);
  const documented = workdays.filter((d) => d.dailyReports.length > 0);
  const done = documented.filter((d) => d.dailyReports.every((r) => ['FINALIZED', 'APPROVED'].includes(r.status)));
  const review = documented.filter((d) => d.dailyReports.some((r) => r.status === 'REVIEW_REQUIRED'));
  const missing = workdays.filter((d) => d.date < today && d.dailyReports.length === 0);
  const pct = (n) => `${(n / 5) * 100}%`;

  const head = h('header', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, `${fmt.long.format(parse(today))} · KW ${w.isoWeek}`),
    h('h1', {}, first ? `${greeting}, ${first}` : greeting));

  const actions = h('section', { class: 'section', 'aria-labelledby': 'h-actions' },
    h('h2', { id: 'h-actions', class: 'eyebrow' }, 'Schnellzugriff'),
    h('a', { class: 'btn primary wide', href: `#/woche/${today}` }, icon('plus'), 'Bericht für heute schreiben'),
    h('div', { class: 'actions' },
      h('a', { class: 'action', href: `#/woche/${w.weekStart}` }, icon('doc'), h('strong', {}, 'Wochenbericht'), h('span', {}, `KW ${w.isoWeek}`)),
      h('a', { class: 'action', href: '#/kalender' }, icon('cal'), h('strong', {}, 'Kalender'), h('span', {}, 'Monatsübersicht')),
      h('a', { class: 'action', href: `#/pdf/${w.weekStart}` }, icon('pdf'), h('strong', {}, 'PDF exportieren'), h('span', {}, 'Druckansicht A4'))));
  const beamHost = actions.querySelector('.btn.primary');
  const beam = borderBeam(beamHost, { size: 'md', colorVariant: 'ocean', strength: 0.7, duration: 3.6 });
  beam.setActive(true);
  onLeave(() => beam.destroy());

  const progress = h('section', { class: 'section', 'aria-labelledby': 'h-week' },
    h('div', { class: 'section-head' }, h('h2', { id: 'h-week' }, 'Diese Woche'), h('a', { class: 'btn ghost', href: `#/woche/${w.weekStart}` }, 'Woche öffnen')),
    h('p', {}, h('strong', { class: 'num', style: null }, `${documented.length} / 5`), h('span', { class: 'muted' }, ' Werktage dokumentiert')),
    h('div', { class: 'bar', role: 'img', 'aria-label': `${done.length} fertig, ${documented.length - done.length - review.length} dokumentiert, ${review.length} zu prüfen, ${5 - documented.length} offen` },
      seg(pct(done.length), 'var(--ok)'), seg(pct(documented.length - done.length - review.length), 'var(--accent)'), seg(pct(review.length), 'var(--warn)')),
    h('div', { class: 'legend' },
      h('span', {}, h('b', {}, done.length), ' fertig'), h('span', {}, h('b', {}, documented.length - done.length - review.length), ' dokumentiert'),
      h('span', {}, h('b', {}, review.length), ' zu prüfen'), h('span', {}, h('b', {}, 5 - documented.length), ' offen')),
    h('div', { class: 'toolbar' }, h('span', { class: 'muted small' }, 'Wochenbericht:'), w.weeklyReport ? badge(w.weeklyReport.status) : h('span', { class: 'badge neutral' }, 'noch nicht erstellt')));

  const tasks = h('section', { class: 'section', 'aria-labelledby': 'h-tasks' }, h('h2', { id: 'h-tasks' }, 'Anstehend'),
    missing.length || review.length || !w.weeklyReport
      ? h('div', { class: 'list' },
        missing.map((d) => h('a', { class: 'row-item', href: `#/woche/${d.date}` }, h('span', { class: 'badge warn' }, icon('warn'), 'fehlt'),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `${fmt.day.format(parse(d.date))} nachtragen`), h('div', { class: 'sub' }, 'Werktag ohne Eintrag (Tagesarten wie Urlaub kennt nur die App)')))),
        review.map((d) => h('a', { class: 'row-item', href: `#/woche/${d.date}` }, badge('REVIEW_REQUIRED'), h('div', { class: 'grow' }, h('div', { class: 'title' }, `${fmt.day.format(parse(d.date))} prüfen`)))),
        !w.weeklyReport && documented.length ? h('a', { class: 'row-item', href: `#/woche/${w.weekStart}` }, h('span', { class: 'badge run' }, icon('edit'), 'offen'),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `Wochenbericht KW ${w.isoWeek} schreiben`))) : null)
      : h('p', { class: 'muted' }, 'Keine offenen Aufgaben in dieser Woche.'));

  const recent = h('section', { class: 'section', 'aria-labelledby': 'h-recent' }, h('h2', { id: 'h-recent' }, 'Zuletzt bearbeitet'),
    recentDaily.data.length + recentWeekly.data.length === 0
      ? h('p', { class: 'muted' }, 'Noch keine Berichte auf dem Server.')
      : h('div', { class: 'list' },
        recentWeekly.data.map((r) => h('a', { class: 'row-item', href: `#/woche/${r.weekStart}` }, icon('doc'),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `Wochenbericht KW ${r.isoWeek}/${r.isoYear}`), h('div', { class: 'sub' }, r.content || 'Ohne Text')), badge(r.status))),
        recentDaily.data.map((r) => h('a', { class: 'row-item', href: `#/woche/${r.date}` }, icon('edit'),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, r.text), h('div', { class: 'sub' }, `Tätigkeit · ${fmt.day.format(parse(r.date))}`)), badge(r.status)))));

  const orb = thinkingOrb({ state: 'breathing', size: 20, animate: false, label: 'KI: nur in der App' });
  onLeave(() => orb.destroy());
  const apps = devices.data.filter((d) => !d.revokedAt && d.platform !== 'WEB');
  const lastSync = apps.map((d) => d.lastSyncAt).filter(Boolean).sort().at(-1);
  const status = h('section', { class: 'section', 'aria-labelledby': 'h-status' }, h('h2', { id: 'h-status' }, 'Status'),
    h('div', { class: 'list' },
      h('div', { class: 'row-item' }, icon('sync'), h('div', { class: 'grow' },
        h('div', { class: 'title' }, apps.length ? `${apps.length} ${apps.length === 1 ? 'Gerät' : 'Geräte'} verbunden` : 'Noch kein Gerät synchronisiert'),
        h('div', { class: 'sub' }, lastSync ? `Letzte erfolgreiche Synchronisierung eines Geräts: ${when(lastSync)}` : 'Die Android-App überträgt Berichte, sobald sie angemeldet ist.')),
      apps.some((d) => d.syncStatus === 'FAILED') ? h('span', { class: 'badge err' }, icon('err'), 'Fehler') : apps.some((d) => d.unresolvedConflicts > 0) ? h('span', { class: 'badge warn' }, icon('warn'), 'Konflikt') : null),
      h('a', { class: 'row-item', href: '#/ki' }, orb.el, h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Lokale KI'), h('div', { class: 'sub' }, 'Läuft ausschließlich in der Android-App – der Server verarbeitet keine Texte mit KI.')))));

  return [head, actions, progress, tasks, recent, status];
}
function seg(width, color) {
  const s = h('span');
  s.style.width = width;
  s.style.background = color;
  return s;
}

// --- Woche / Editor ---------------------------------------------------------------------------------------------

async function viewWeek(date = iso(new Date())) {
  const { data: w } = await api('GET', `/weeks/${date}`);
  const prev = iso(addDays(parse(w.weekStart), -7));
  const next = iso(addDays(parse(w.weekStart), 7));
  const head = h('header', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, 'Ausbildungsnachweis · Wochenbericht'),
    h('div', { class: 'row' }, h('h1', {}, `Kalenderwoche ${w.isoWeek}`),
      h('a', { class: 'btn ghost', href: `#/woche/${prev}`, 'aria-label': 'Vorherige Woche' }, icon('left')),
      h('a', { class: 'btn ghost', href: `#/woche/${next}`, 'aria-label': 'Nächste Woche' }, icon('right'))),
    h('p', { class: 'muted num' }, `${fmt.date.format(parse(w.weekStart))} – ${fmt.date.format(parse(w.weekEnd))}`));

  // Wochenbericht: Text mit echtem Speicherstatus (gespeichert / speichert / ausstehend / Fehler).
  let report = w.weeklyReport;
  const text = h('textarea', { class: 'input doc', id: 'weekly', 'aria-label': 'Wochenbericht' });
  text.value = report?.content ?? '';
  const saveState = h('span', { class: 'savestate', role: 'status' });
  const setState = (kind, label) => saveState.replaceChildren(icon({ ok: 'check', run: 'sync', pending: 'edit', err: 'err' }[kind]), label);
  setState('ok', report ? `Gespeichert · ${when(report.updatedAt)}` : 'Noch kein Wochenbericht');
  const status = h('select', { class: 'input', id: 'wstatus', 'aria-label': 'Status' },
    Object.entries(STATUS).filter(([k]) => k !== 'GENERATED').map(([k, v]) => h('option', { value: k, selected: (report?.status ?? 'DRAFT') === k }, v.label)));
  const editor = h('div', { class: 'panel' }, text);
  const beam = borderBeam(editor, { size: 'line', colorVariant: 'ocean', strength: 0.8 });
  onLeave(() => beam.destroy());
  let timer = 0;
  let saving = false;
  const save = async () => {
    if (saving) return;
    saving = true;
    setState('run', 'Speichern läuft …');
    beam.setActive(true);
    try {
      const body = { weekStart: w.weekStart, content: text.value, status: status.value };
      const out = report
        ? await api('PUT', `/weekly-reports/${report.id}`, { ...body, version: report.version })
        : await api('POST', '/weekly-reports', body);
      report = out.data;
      setState('ok', `Gespeichert · ${when(report.updatedAt)}`);
    } catch (e) {
      setState('err', e.status === 409 ? 'Konflikt: auf einem anderen Gerät geändert – Seite neu laden' : `Fehler: ${e.message}`);
    } finally {
      saving = false;
      beam.setActive(false);
    }
  };
  const schedule = () => { setState('pending', 'Lokale Änderungen ausstehend'); clearTimeout(timer); timer = setTimeout(save, 1200); };
  text.addEventListener('input', schedule);
  status.addEventListener('change', save);
  onLeave(() => { if (timer) { clearTimeout(timer); save(); } });

  const weekly = h('section', { class: 'section', 'aria-labelledby': 'h-weekly' },
    h('div', { class: 'section-head' }, h('h2', { id: 'h-weekly' }, 'Wochenbericht'), saveState),
    h('div', { class: 'toolbar' }, h('label', { for: 'wstatus', class: 'small muted' }, 'Status'), status,
      h('a', { class: 'btn outline', href: `#/pdf/${w.weekStart}` }, icon('print'), 'Druckansicht')),
    editor,
    h('p', { class: 'muted small' }, 'Die KI-Formulierung ist in der Android-App verfügbar (lokal auf dem Gerät).'));

  // Tagesberichte: Tätigkeiten je Tag.
  const days = h('section', { class: 'section', 'aria-labelledby': 'h-days' }, h('h2', { id: 'h-days' }, 'Tätigkeiten'),
    h('div', { class: 'list' }, w.days.map((d) => dayBlock(d, () => route()))));
  return [head, weekly, days];
}

function dayBlock(day, reload) {
  const add = h('button', { class: 'btn ghost', type: 'button' }, icon('plus'), 'Tätigkeit');
  add.addEventListener('click', () => editDaily(null, day.date, reload));
  return h('div', { class: 'row-item', style: null },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, fmt.long.format(parse(day.date))),
      day.dailyReports.length
        ? day.dailyReports.map((r) => h('button', { class: 'row-item', type: 'button', onclick: () => editDaily(r, day.date, reload) },
          h('div', { class: 'grow' }, h('div', {}, r.text), r.note ? h('div', { class: 'sub' }, r.note) : null), badge(r.status)))
        : h('p', { class: 'muted small' }, 'Kein Eintrag')),
    add);
}

function editDaily(rep, date, reload) {
  const text = h('textarea', { class: 'input', id: 'dtext', rows: '5', required: true });
  text.value = rep?.text ?? '';
  const note = h('input', { class: 'input', id: 'dnote' });
  note.value = rep?.note ?? '';
  const status = h('select', { class: 'input', id: 'dstatus' },
    Object.entries(STATUS).filter(([k]) => k !== 'GENERATED').map(([k, v]) => h('option', { value: k, selected: (rep?.status ?? 'DRAFT') === k }, v.label)));
  const error = h('p', { class: 'error', role: 'alert' });
  const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' },
    h('h2', { id: 'dlg-title' }, `${rep ? 'Tätigkeit bearbeiten' : 'Tätigkeit erfassen'} · ${fmt.day.format(parse(date))}`),
    h('div', { class: 'field' }, h('label', { for: 'dtext' }, 'Tätigkeit'), text),
    h('div', { class: 'field' }, h('label', { for: 'dnote' }, 'Notiz (optional)'), note),
    h('div', { class: 'field' }, h('label', { for: 'dstatus' }, 'Status'), status),
    error,
    h('div', { class: 'dlg-actions' },
      rep ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm('Tätigkeit löschen? Sie wird auch auf deinen Geräten entfernt (dort zuerst in den Papierkorb).')) return;
        try { await api('DELETE', `/daily-reports/${rep.id}?version=${rep.version}`); dlg.close(); reload(); } catch (e) { error.textContent = e.message; }
      } }, 'Löschen') : null,
      h('button', { class: 'btn outline', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (!text.value.trim()) { error.textContent = 'Bitte eine Tätigkeit eingeben.'; text.focus(); return; }
        const body = { date, text: text.value.trim(), note: note.value.trim(), status: status.value, orderIndex: rep?.orderIndex ?? 0 };
        try {
          if (rep) await api('PUT', `/daily-reports/${rep.id}`, { ...body, version: rep.version });
          else await api('POST', '/daily-reports', body);
          dlg.close();
          toast('Gespeichert – die App übernimmt es bei der nächsten Synchronisierung.');
          reload();
        } catch (e) {
          error.textContent = e.status === 409 ? 'Konflikt: Die Tätigkeit wurde inzwischen auf einem anderen Gerät geändert. Bitte neu laden.' : e.message;
        }
      } }, 'Speichern')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  text.focus();
}

// --- Berichte ---------------------------------------------------------------------------------------------------

async function viewReports() {
  const [weekly, daily] = await Promise.all([api('GET', '/weekly-reports?limit=100'), api('GET', '/daily-reports?limit=100')]);
  const search = h('input', { class: 'input', type: 'search', id: 'q', placeholder: 'Berichte durchsuchen', 'aria-label': 'Berichte durchsuchen' });
  const kind = h('select', { class: 'input', 'aria-label': 'Art' }, h('option', { value: 'all' }, 'Alle'), h('option', { value: 'w' }, 'Wochenberichte'), h('option', { value: 'd' }, 'Tagesberichte'));
  const list = h('div', { class: 'list' });
  const items = [
    ...weekly.data.map((r) => ({ kind: 'w', date: r.weekStart, text: r.content, el: () => h('a', { class: 'row-item', href: `#/woche/${r.weekStart}` }, icon('doc'),
      h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Wochenbericht'), h('div', { class: 'title' }, `KW ${r.isoWeek}/${r.isoYear}`),
        h('div', { class: 'sub' }, r.content || 'Ohne Text')), badge(r.status)) })),
    ...daily.data.map((r) => ({ kind: 'd', date: r.date, text: `${r.text} ${r.note}`, el: () => h('a', { class: 'row-item', href: `#/woche/${r.date}` }, icon('edit'),
      h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Tagesbericht'), h('div', { class: 'title' }, fmt.long.format(parse(r.date))),
        h('div', { class: 'sub' }, r.text)), badge(r.status)) })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = items.filter((i) => (kind.value === 'all' || i.kind === kind.value) && (!q || i.text.toLowerCase().includes(q)));
    list.replaceChildren(...(shown.length ? shown.map((i) => i.el()) : [h('p', { class: 'muted', style: null }, 'Keine Berichte für diese Auswahl.')]));
  };
  search.addEventListener('input', render);
  kind.addEventListener('change', render);
  render();
  const more = weekly.meta?.hasMore || daily.meta?.hasMore;
  return [
    h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, 'Dokumente'), h('h1', {}, 'Berichte')),
    h('div', { class: 'grid-2' }, search, kind),
    list,
    more ? h('p', { class: 'muted small' }, 'Es werden die jeweils neuesten 100 Berichte angezeigt.') : null,
  ];
}

// --- Kalender ---------------------------------------------------------------------------------------------------

async function viewCalendar(month) {
  const base = month ? parse(`${month}-01`) : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = monday(first);
  const end = addDays(start, 41);
  const { data } = await api('GET', `/daily-reports?from=${iso(start)}&to=${iso(end)}&limit=100`);
  const byDate = new Map();
  for (const r of data) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const todayIso = iso(new Date());
  const detail = h('section', { class: 'section', 'aria-live': 'polite' });
  const grid = h('div', { class: 'cal', role: 'grid', 'aria-label': fmt.month.format(first) },
    h('span', { class: 'head' }, 'KW'), ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => h('span', { class: 'head' }, d)));
  for (let wk = 0; wk < 6; wk++) {
    const ws = addDays(start, wk * 7);
    grid.append(h('span', { class: 'kw' }, isoWeek(ws)));
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const key = iso(d);
      const reps = byDate.get(key) ?? [];
      const worst = reps.some((r) => r.status === 'REVIEW_REQUIRED') ? 'REVIEW_REQUIRED' : reps.length && reps.every((r) => ['FINALIZED', 'APPROVED'].includes(r.status)) ? 'FINALIZED' : reps.length ? 'EDITED' : null;
      const missing = !reps.length && key < todayIso && i < 5 && d.getMonth() === first.getMonth();
      const label = `${fmt.long.format(d)}${reps.length ? `, ${reps.length} ${reps.length === 1 ? 'Eintrag' : 'Einträge'}, ${STATUS[worst].label}` : missing ? ', fehlt' : ''}`;
      const btn = h('button', { class: `day${d.getMonth() !== first.getMonth() ? ' other' : ''}${reps.length ? ' has' : ''}${key === todayIso ? ' today' : ''}`, type: 'button', 'aria-label': label, 'aria-pressed': 'false' },
        d.getDate(), worst ? h('span', { class: `mark`, style: null }, statusIcon(worst)) : missing ? h('span', { class: 'mark' }, statusIcon('MISSING')) : null);
      btn.addEventListener('click', () => {
        grid.querySelectorAll('[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        detail.replaceChildren(h('h2', {}, fmt.long.format(d)),
          reps.length ? h('div', { class: 'list' }, reps.map((r) => h('div', { class: 'row-item' }, h('div', { class: 'grow' }, h('div', {}, r.text), r.note ? h('div', { class: 'sub' }, r.note) : null), badge(r.status))))
            : h('p', { class: 'muted' }, missing ? 'Werktag ohne Eintrag.' : 'Kein Eintrag.'),
          h('div', { class: 'toolbar' }, h('a', { class: 'btn primary', href: `#/woche/${key}` }, reps.length ? 'In der Woche bearbeiten' : 'Eintragen')));
      });
      grid.append(btn);
    }
  }
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return [
    h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, 'Kalender'),
      h('div', { class: 'row' }, h('h1', {}, fmt.month.format(first)),
        h('a', { class: 'btn ghost', href: `#/kalender/${ym(new Date(first.getFullYear(), first.getMonth() - 1, 1))}`, 'aria-label': 'Vorheriger Monat' }, icon('left')),
        h('a', { class: 'btn ghost', href: `#/kalender/${ym(new Date(first.getFullYear(), first.getMonth() + 1, 1))}`, 'aria-label': 'Nächster Monat' }, icon('right')))),
    h('div', { class: 'panel pad' }, grid),
    h('p', { class: 'muted small' }, 'Symbole: Haken = fertig, Stift = in Bearbeitung, Warndreieck = Prüfung bzw. fehlender Werktag. Tagesarten (Urlaub, Schule …) verwaltet die App.'),
    detail,
  ];
}
function statusIcon(s) {
  const map = { FINALIZED: ['check', 'var(--ok)'], EDITED: ['edit', 'var(--run)'], REVIEW_REQUIRED: ['warn', 'var(--warn)'], MISSING: ['warn', 'var(--warn)'] };
  const [name, color] = map[s] ?? ['draft', 'var(--ink-2)'];
  const i = icon(name);
  i.style.color = color;
  return i;
}

// --- PDF Studio (Druckansicht) ----------------------------------------------------------------------------------

async function viewPdf(date = iso(new Date())) {
  const [{ data: w }, { data: p }] = await Promise.all([api('GET', `/weeks/${date}`), api('GET', '/profile')]);
  const prev = iso(addDays(parse(w.weekStart), -7));
  const next = iso(addDays(parse(w.weekStart), 7));
  const missing = ['name', 'company', 'profession'].filter((k) => !p[k]);
  const sheet = h('article', { class: 'sheet', 'aria-label': `Druckvorschau Kalenderwoche ${w.isoWeek}` },
    h('div', { class: 'top' },
      h('div', {}, h('strong', {}, p.name || ''), h('div', {}, `${fmt.date.format(parse(w.weekStart))} – ${fmt.date.format(parse(w.weekEnd))}`)),
      h('div', { class: 'right' }, h('strong', {}, p.company || ''), h('div', {}, p.profession || ''))),
    h('h2', {}, `Ausbildungsnachweis · Kalenderwoche ${w.isoWeek}/${w.isoYear}`),
    w.days.filter((d) => d.dailyReports.length).map((d) => h('div', { class: 'day' }, h('b', {}, fmt.long.format(parse(d.date))),
      d.dailyReports.map((r) => h('div', {}, `• ${r.text}${r.note ? ` (${r.note})` : ''}`)))),
    w.weeklyReport?.content ? h('div', { class: 'day' }, h('b', {}, 'Wochenbericht'), h('p', {}, w.weeklyReport.content)) : null,
    h('div', { class: 'signs' }, h('div', {}, 'Ort, Datum'), h('div', {}, 'Auszubildende/r'), h('div', {}, 'Ausbilder/in')),
    h('div', { class: 'foot' }, 'Seite 1'));
  return [
    h('header', { class: 'page-head no-print' }, h('p', { class: 'eyebrow' }, 'PDF Studio · Wochenvorlage'),
      h('div', { class: 'row' }, h('h1', {}, `KW ${w.isoWeek}`),
        h('a', { class: 'btn ghost', href: `#/pdf/${prev}`, 'aria-label': 'Vorherige Woche' }, icon('left')),
        h('a', { class: 'btn ghost', href: `#/pdf/${next}`, 'aria-label': 'Nächste Woche' }, icon('right')))),
    missing.length ? h('div', { class: 'notice warn no-print' }, icon('warn'), h('p', {}, `Im Profil fehlen: ${missing.map((k) => ({ name: 'Name', company: 'Betrieb', profession: 'Ausbildungsberuf' })[k]).join(', ')}. Sie werden im Kopf weggelassen.`)) : null,
    h('div', { class: 'notice info no-print' }, icon('pdf'), h('p', {}, 'Die Vorschau entspricht der Wochenvorlage der App (A4, Name und Datum links, Betrieb und Beruf rechts, Unterschriftsfelder). Das PDF erzeugt dein Browser lokal über „Drucken → Als PDF speichern“. Seitenumbrüche bei sehr langen Wochen bestimmt der Browser; die mehrseitige Vorlage mit Seitenzahlen erstellt das PDF Studio der App.')),
    h('div', { class: 'toolbar no-print' }, h('button', { class: 'btn primary', type: 'button', onclick: () => print() }, icon('print'), 'Drucken / als PDF speichern')),
    sheet,
  ];
}

// --- KI ---------------------------------------------------------------------------------------------------------

async function viewAi() {
  const orb = thinkingOrb({ state: 'breathing', size: 64, animate: false, label: 'KI im Ruhezustand' });
  onLeave(() => orb.destroy());
  return [
    h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, 'KI-Assistent'), h('h1', {}, 'Die KI läuft auf deinem Gerät')),
    h('div', { class: 'panel pad', style: null }, h('div', { class: 'toolbar' }, orb.el,
      h('div', { class: 'grow' },
        h('p', {}, 'Formulieren, Verbessern, Zusammenfassen und der Zeitraum-Assistent arbeiten in der Android-App – mit einem lokalen Sprachmodell oder dem regelbasierten Assistenten, ohne Internet.'),
        h('p', { class: 'muted small' }, 'Dieser Server hat keine KI und überträgt keine Berichtsinhalte an KI-Dienste. Deshalb gibt es hier keinen Chat, der Verarbeitung nur vortäuschen würde. Entwürfe aus der App erscheinen nach der Synchronisierung in den Berichten als „KI-Entwurf“.')))),
  ];
}

// --- Einstellungen ----------------------------------------------------------------------------------------------

async function viewSettings() {
  const [{ data: account }, { data: profile }, devices, legal] = await Promise.all([
    api('GET', '/account'), api('GET', '/profile'), api('GET', '/devices').catch(() => ({ data: [] })), api('GET', '/legal').catch(() => ({ data: {} })),
  ]);
  const theme = h('select', { class: 'input', id: 'theme' },
    [['system', 'Wie das System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => h('option', { value: v, selected: (prefs.get('theme') ?? 'system') === v }, l)));
  theme.addEventListener('change', () => { prefs.set('theme', theme.value); applyTheme(theme.value); });

  const fields = [['name', 'Name'], ['profession', 'Ausbildungsberuf'], ['company', 'Ausbildungsbetrieb'], ['department', 'Abteilung'], ['trainerName', 'Ausbilder/in']];
  const inputs = Object.fromEntries(fields.map(([k]) => [k, Object.assign(h('input', { class: 'input', id: `p-${k}` }), { value: profile[k] ?? '' })]));
  const msg = h('p', { class: 'small', role: 'status' });
  const saveProfile = h('button', { class: 'btn primary', type: 'button' }, 'Profil speichern');
  let version = profile.version;
  saveProfile.addEventListener('click', async () => {
    try {
      const body = { ...profile, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])), version };
      const { data } = await api('PUT', '/profile', body);
      version = data.version;
      msg.textContent = 'Gespeichert.';
    } catch (e) {
      msg.textContent = e.status === 409 ? 'Das Profil wurde inzwischen auf einem anderen Gerät geändert. Bitte neu laden.' : e.message;
    }
  });

  const exportBtn = h('button', { class: 'btn outline', type: 'button' }, 'Meine Daten exportieren (JSON)');
  exportBtn.addEventListener('click', async () => {
    try {
      const out = await api('GET', '/account/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(out.data, null, 2)], { type: 'application/json' }));
      h('a', { href: url, download: `berichtly-export-${iso(new Date())}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast(e.message); }
  });

  return [
    h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, account.email), h('h1', {}, 'Einstellungen')),
    h('section', { class: 'section' }, h('h2', {}, 'Darstellung'), h('div', { class: 'field' }, h('label', { for: 'theme' }, 'Design'), theme)),
    h('section', { class: 'section' }, h('h2', {}, 'Profil'), h('p', { class: 'muted small' }, 'Wird mit der App synchronisiert und erscheint im Kopf der PDF.'),
      h('div', { class: 'grid-2' }, fields.map(([k, l]) => h('div', { class: 'field' }, h('label', { for: `p-${k}` }, l), inputs[k]))),
      h('div', { class: 'toolbar' }, saveProfile, msg)),
    h('section', { class: 'section' }, h('h2', {}, 'Geräte und Synchronisierung'),
      h('div', { class: 'list' }, devices.data.filter((d) => !d.revokedAt).map((d) => h('div', { class: 'row-item' }, icon(d.platform === 'WEB' ? 'home' : 'sync'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${d.name} · ${d.platform}`), h('div', { class: 'sub' }, `Zuletzt aktiv ${when(d.lastSeenAt)} · letzte erfolgreiche Synchronisierung ${when(d.lastSyncAt)}`)),
        d.syncStatus === 'FAILED' ? h('span', { class: 'badge err' }, icon('err'), 'Fehler') : d.unresolvedConflicts > 0 ? h('span', { class: 'badge warn' }, icon('warn'), `${d.unresolvedConflicts} Konflikte`) : d.syncStatus === 'SUCCESS' ? h('span', { class: 'badge ok' }, icon('check'), 'OK') : null)))),
    h('section', { class: 'section' }, h('h2', {}, 'Datenschutz'),
      h('p', { class: 'muted small' }, 'Die Weboberfläche speichert die Anmeldung nur für diesen Tab (sessionStorage) sowie Design und eine zufällige Geräte-ID im Browser. Keine Cookies, kein Tracking, keine externen Schriften oder Skripte.'),
      h('div', { class: 'toolbar' }, exportBtn,
        legal.data?.privacyUrl ? h('a', { class: 'btn ghost', href: legal.data.privacyUrl }, 'Datenschutzerklärung') : null,
        legal.data?.imprintUrl ? h('a', { class: 'btn ghost', href: legal.data.imprintUrl }, 'Impressum') : null)),
    h('section', { class: 'section' }, h('h2', {}, 'Administration'),
      h('p', { class: 'muted small' }, 'Nur für Konten mit Administratorrolle und wenn der Betreiber das Dashboard aktiviert hat.'),
      h('div', { class: 'toolbar' }, h('a', { class: 'btn outline', href: '/admin' }, icon('admin'), 'Zum Admin-Dashboard'))),
  ];
}

route();
