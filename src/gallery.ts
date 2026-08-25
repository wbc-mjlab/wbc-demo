/**
 * Clip gallery — a wall of LIVE thumbnails.
 *
 * Every clip of every live-capable policy gets its own card. Rather than spawn
 * one WebGL context per card (the browser caps ~16, and 30+ sims would melt the
 * CPU), a small POOL of engines is shared: an engine is created lazily, and as
 * you scroll it is reassigned to whichever cards are on-screen — moving its
 * canvas into the card and swapping the cheap per-clip reference stream
 * (`selectClip`, a ~50 ms fetch). Off-screen cards release their engine back to
 * the pool. Clicking a card opens the full demo on that clip.
 */

import './styles/app.css';
import './styles/live.css';
import { discoverPolicies } from './registry';
import { createLiveEngine, type LiveEngineHandle } from './engine/live-engine';
import { loadReferenceIndex } from './engine/policy-config';
import {
  browsableClipsWithoutManifest,
  loadClipManifest,
  resolveBrowsableClips,
} from './engine/clip-manifest';
import type { PolicyEntry } from './types';
import {
  THEME_EVENT,
  initTheme,
  themeToggleHtml,
  wireThemeToggle,
} from './theme';

initTheme();

const EXAMPLE_ID = '_example';
/** Engine pool size — caps live WebGL contexts + CPU regardless of card count. */
const MAX_LIVE = 6;

interface ClipCard {
  policyId: string;
  policyBaseUrl: string;
  mjcfBaseUrl: string;
  clipId: string;
  el: HTMLElement;
  stage: HTMLElement;
  badge: HTMLElement;
}

const pool: LiveEngineHandle[] = [];
const engineOf = new Map<ClipCard, LiveEngineHandle>();
const cardOf = new Map<LiveEngineHandle, ClipCard>();
const visible = new Set<ClipCard>();
const booting = new Set<ClipCard>();
let creating = 0;

/** Clip cards open tracking mode so the selected reference plays immediately. */
function demoHref(policyId: string, clipId: string): string {
  const b = import.meta.env.BASE_URL;
  const q = new URLSearchParams({ id: policyId, clip: clipId });
  return `${b}tracking.html?${q}`;
}

function isLiveCapable(entry: PolicyEntry): boolean {
  if (entry.id === EXAMPLE_ID) return false;
  return Boolean(entry.manifest.artifacts?.onnx) && (entry.manifest.robot ?? 'g1') === 'g1';
}
function mjcfBaseUrl(entry: PolicyEntry): string {
  return `${import.meta.env.BASE_URL}robots/${entry.manifest.robot ?? 'g1'}/mjcf/`;
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface GalleryClip { id: string; name: string; tags?: string[] }

// Lead with reliable locomotion; push fight/flip/sport later for a strong open.
const CLIP_ORDER = ['walk', 'run', 'sprint', 'locomotion', 'idle', 'dance', 'jump', 'fight', 'sport', 'flip'];
function clipRank(clip: GalleryClip): number {
  const hay = `${clip.id} ${(clip.tags ?? []).join(' ')}`.toLowerCase();
  let best = CLIP_ORDER.length;
  CLIP_ORDER.forEach((kw, i) => { if (i < best && hay.includes(kw)) best = i; });
  return best;
}

function setBadge(card: ClipCard, label: string, state: string): void {
  card.badge.textContent = label;
  card.badge.dataset.live = state;
}

function clipCardHtml(policy: PolicyEntry, clip: { id: string; name: string; tags?: string[] }): string {
  const tags = (clip.tags ?? []).slice(0, 3)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  return `
    <a class="gcard" href="${demoHref(policy.id, clip.id)}" data-policy="${policy.id}" data-clip="${escapeHtml(clip.id)}">
      <div class="gcard__stage"></div>
      <div class="gcard__overlay" aria-hidden="true"></div>
      <div class="gcard__bar">
        <span class="gcard__title">${escapeHtml(clip.name)}</span>
        <span class="gcard__badge" data-live="idle">●&nbsp;idle</span>
      </div>
      <div class="gcard__body">
        <p class="gcard__desc">${escapeHtml(policy.manifest.name)}</p>
        ${tags ? `<div class="gcard__tags">${tags}</div>` : ''}
      </div>
    </a>`;
}

function staticCardHtml(entry: PolicyEntry): string {
  const { manifest } = entry;
  const tags = (manifest.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const q = new URLSearchParams({ id: entry.id });
  return `
    <a class="gcard" href="${import.meta.env.BASE_URL}?${q}" data-id="${entry.id}">
      <div class="gcard__stage"></div>
      <div class="gcard__overlay" aria-hidden="true"></div>
      <div class="gcard__bar">
        <span class="gcard__title">${escapeHtml(manifest.name)}
          <span class="badge-example">example</span></span>
        <span class="gcard__badge" data-live="static">static</span>
      </div>
      <div class="gcard__body">
        ${manifest.description ? `<p class="gcard__desc">${escapeHtml(manifest.description)}</p>` : ''}
        ${tags ? `<div class="gcard__tags">${tags}</div>` : ''}
      </div>
    </a>`;
}

// ---- engine pool scheduling -------------------------------------------------
let scheduling = false;
let dirty = false;

async function schedule(): Promise<void> {
  if (scheduling) { dirty = true; return; }
  scheduling = true;
  try {
    // Pause engines whose card scrolled off (keep them assigned for fast return).
    for (const [eng, card] of cardOf) if (!visible.has(card)) eng.pause();

    for (const card of visible) {
      const existing = engineOf.get(card);
      if (existing) { existing.play(); continue; }
      if (booting.has(card)) continue;

      // Free up a slot: create a new engine until the pool is full, else steal
      // one from an off-screen card.
      if (pool.length + creating < MAX_LIVE) {
        await createForCard(card);
      } else {
        const victim = pool.find((e) => {
          const c = cardOf.get(e);
          return !c || !visible.has(c);
        });
        if (victim) reassign(victim, card);
        // else: every engine is on a visible card — this one waits (idle poster).
      }
    }
  } finally {
    scheduling = false;
    if (dirty) { dirty = false; void schedule(); }
  }
}

async function createForCard(card: ClipCard): Promise<void> {
  booting.add(card);
  creating += 1;
  setBadge(card, 'loading…', 'boot');
  try {
    const eng = await createLiveEngine(card.stage, {
      policyBaseUrl: card.policyBaseUrl,
      mjcfBaseUrl: card.mjcfBaseUrl,
      startClipId: card.clipId,
      autoplay: true,
      follow: true,
      lowQuality: true,
      onStatus: (s) => {
        if (cardOf.get(eng) === card) setBadge(card, s.fell ? '● fell' : '● live', s.fell ? 'fell' : 'live');
      },
    });
    pool.push(eng);
    assign(eng, card);
    if (!visible.has(card)) eng.pause();
  } catch {
    setBadge(card, 'err', 'fell');
  } finally {
    creating -= 1;
    booting.delete(card);
    if (dirty) { dirty = false; void schedule(); }
  }
}

function assign(eng: LiveEngineHandle, card: ClipCard): void {
  cardOf.set(eng, card);
  engineOf.set(card, eng);
  setBadge(card, '● live', 'live');
}

function reassign(eng: LiveEngineHandle, card: ClipCard): void {
  const prev = cardOf.get(eng);
  if (prev) { engineOf.delete(prev); setBadge(prev, '▶ open', 'capped'); }
  eng.reparent(card.stage);
  assign(eng, card);
  void eng.selectClip(card.clipId).then(() => { eng.reframe(); eng.play(); });
}

function observeCards(cards: ClipCard[]): void {
  const byEl = new Map<Element, ClipCard>();
  for (const c of cards) byEl.set(c.el, c);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const card = byEl.get(e.target);
        if (!card) continue;
        if (e.isIntersecting) visible.add(card);
        else visible.delete(card);
      }
      void schedule();
    },
    { rootMargin: '100px', threshold: 0.1 },
  );
  for (const c of cards) io.observe(c.el);
}

// ---- render -----------------------------------------------------------------
async function render(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;
  const policies = discoverPolicies();
  const home = import.meta.env.BASE_URL;
  const tracking = `${home}tracking.html`;

  root.innerHTML = `
    <header class="site-header">
      <div class="site-header__row">
        <div>
          <p class="back-link">
            <a href="${home}">← gen demo</a>
            ·
            <a href="${tracking}">tracking</a>
          </p>
          <h1>wbc-mjlab policy demos</h1>
        </div>
        ${themeToggleHtml('gallery-theme')}
      </div>
      <p>
        Interactive in-browser whole-body control. Every card is a motion clip
        tracked <strong>live in its own MuJoCo sim</strong> — scroll to bring more
        to life, click one to open <strong>tracking</strong> mode on that clip.
      </p>
    </header>
    <div class="gallery gallery--live" id="grid"></div>`;
  wireThemeToggle(root.querySelector<HTMLButtonElement>('#gallery-theme'));
  window.addEventListener(THEME_EVENT, () => {
    for (const eng of pool) eng.viewer.applyThemeColors();
  });
  const grid = root.querySelector<HTMLElement>('#grid')!;

  // Static (non-live) policies first as simple cards.
  const livePolicies = policies.filter(isLiveCapable);
  const staticPolicies = policies.filter((p) => !isLiveCapable(p));

  const cards: ClipCard[] = [];
  // Fetch every live policy's clip list, gather (policy, clip) pairs, drop the
  // floor-start fallers, and sort so locomotion leads the wall.
  const gathered = await Promise.all(
    livePolicies.map(async (entry) => {
      try {
        const base = `${entry.baseUrl}reference/`;
        const idx = await loadReferenceIndex(`${base}index.json`);
        let browsable = browsableClipsWithoutManifest(idx);
        try {
          const manifest = await loadClipManifest(`${base}manifest.yaml`);
          browsable = resolveBrowsableClips(idx, manifest);
        } catch {
          /* no manifest — non-pose clips only */
        }
        return browsable.map((clip) => ({ entry, clip: clip as GalleryClip }));
      } catch (err) {
        console.warn(`[gallery] no reference index for ${entry.id}:`, err);
        return [];
      }
    }),
  );
  const entries = gathered.flat().sort((a, b) => {
    const r = clipRank(a.clip) - clipRank(b.clip);
    return r !== 0 ? r : a.clip.name.localeCompare(b.clip.name);
  });

  for (const { entry, clip } of entries) {
    const wrap = document.createElement('div');
    wrap.innerHTML = clipCardHtml(entry, clip);
    const el = wrap.firstElementChild as HTMLElement;
    grid.appendChild(el);
    cards.push({
      policyId: entry.id,
      policyBaseUrl: entry.baseUrl,
      mjcfBaseUrl: mjcfBaseUrl(entry),
      clipId: clip.id,
      el,
      stage: el.querySelector<HTMLElement>('.gcard__stage')!,
      badge: el.querySelector<HTMLElement>('.gcard__badge')!,
    });
  }

  for (const entry of staticPolicies) {
    grid.insertAdjacentHTML('beforeend', staticCardHtml(entry));
  }

  if (!cards.length && !staticPolicies.length) {
    grid.outerHTML = `<p class="empty">No policies found. Add one under <code>policies/&lt;id&gt;/policy.yaml</code>.</p>`;
    return;
  }
  observeCards(cards);
}

window.addEventListener('beforeunload', () => {
  for (const h of pool) h.dispose();
});

void render();
