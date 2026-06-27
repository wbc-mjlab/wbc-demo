/**
 * Gallery landing page — a wall of LIVE policies.
 *
 * Every policy discovered from `policies/*` (registry.ts) renders as a card. If
 * the policy ships an ONNX + g1 assets, the card hosts a small live WBC engine
 * (src/engine/live-engine.ts) running the policy in its own mujoco-wasm sim —
 * autoplaying, low-quality, camera-following. Clicking a card opens the full
 * interactive per-policy page.
 *
 * Cost control (WebGL contexts + CPU): engines are created LAZILY when a card
 * scrolls into view, PAUSED when it leaves, and capped at MAX_LIVE concurrent
 * instances. Beyond the cap (or for onnx-less policies) the card stays a static
 * poster that still links through. Issue wbc-mjlab-g8h.
 */

import './styles/app.css';
import './styles/live.css';
import { discoverPolicies } from './registry';
import { createLiveEngine, type LiveEngineHandle } from './engine/live-engine';
import type { PolicyEntry } from './types';

const EXAMPLE_ID = '_example';
/** Max simultaneously-running live cards (WebGL context + CPU budget). */
const MAX_LIVE = 6;

const engines = new Map<string, LiveEngineHandle>();
let liveCount = 0;

function policyHref(id: string): string {
  return `${import.meta.env.BASE_URL}policy.html?id=${encodeURIComponent(id)}`;
}

function isLiveCapable(entry: PolicyEntry): boolean {
  // The _example folder is a doc placeholder: its manifest names a policy.onnx
  // that doesn't exist, so never try to run it live.
  if (entry.id === EXAMPLE_ID) return false;
  return Boolean(entry.manifest.artifacts?.onnx) && (entry.manifest.robot ?? 'g1') === 'g1';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderCard(entry: PolicyEntry): string {
  const { manifest } = entry;
  const isExample = entry.id === EXAMPLE_ID;
  const live = isLiveCapable(entry);
  const tags = (manifest.tags ?? [])
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const exampleBadge = isExample
    ? '<span class="badge-example" title="Remove once real policies land">example</span>' : '';
  const badge = live
    ? '<span class="gcard__badge" data-live="boot">●&nbsp;idle</span>'
    : '<span class="gcard__badge" data-live="static">static</span>';

  // Whole card links to the full page; the stage hosts the live canvas, and an
  // overlay above it swallows orbit drags so a click navigates instead of spins.
  return `
    <a class="gcard" href="${policyHref(entry.id)}" data-id="${entry.id}"${live ? ' data-live-card="1"' : ''}>
      <div class="gcard__stage"></div>
      <div class="gcard__overlay" aria-hidden="true"></div>
      <div class="gcard__bar">
        <span class="gcard__title">${escapeHtml(manifest.name)}${exampleBadge}</span>
        ${badge}
      </div>
      <div class="gcard__body">
        ${manifest.description ? `<p class="gcard__desc">${escapeHtml(manifest.description)}</p>` : ''}
        ${tags ? `<div class="gcard__tags">${tags}</div>` : ''}
      </div>
    </a>`;
}

function mjcfBaseUrl(entry: PolicyEntry): string {
  return `${import.meta.env.BASE_URL}robots/${entry.manifest.robot ?? 'g1'}/mjcf/`;
}

/** Lazy-init + pause/resume + cap a card's live engine via IntersectionObserver. */
function wireLiveCard(card: HTMLElement, entry: PolicyEntry): void {
  const stage = card.querySelector<HTMLElement>('.gcard__stage');
  const badge = card.querySelector<HTMLElement>('.gcard__badge');
  if (!stage || !badge) return;
  let booting = false;

  const setBadge = (label: string, state: string) => {
    badge.textContent = label;
    badge.dataset.live = state;
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const h = engines.get(entry.id);
          if (h) { h.play(); setBadge('● live', 'live'); continue; }
          if (booting) continue;
          if (liveCount >= MAX_LIVE) { setBadge('▶ open', 'capped'); continue; }
          booting = true;
          liveCount += 1;
          setBadge('loading…', 'boot');
          createLiveEngine(stage, {
            policyBaseUrl: entry.baseUrl,
            mjcfBaseUrl: mjcfBaseUrl(entry),
            autoplay: true,
            follow: true,
            lowQuality: true,
            onStatus: (s) => {
              if (s.fell) setBadge('● fell', 'fell');
              else setBadge('● live', 'live');
            },
          })
            .then((h) => { engines.set(entry.id, h); setBadge('● live', 'live'); })
            .catch(() => { liveCount -= 1; booting = false; setBadge('err', 'fell'); });
        } else {
          engines.get(entry.id)?.pause();
          if (engines.has(entry.id)) setBadge('❚❚ paused', 'paused');
        }
      }
    },
    { threshold: 0.25 },
  );
  io.observe(card);
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const policies = discoverPolicies();
  const body = policies.length
    ? `<div class="gallery gallery--live">${policies.map(renderCard).join('')}</div>`
    : `<p class="empty">No policies found. Add one under <code>policies/&lt;id&gt;/policy.yaml</code> and open a PR.</p>`;

  root.innerHTML = `
    <header class="site-header">
      <h1>wbc-mjlab policy demos</h1>
      <p>
        Interactive in-browser whole-body-control policies — each card is a policy
        running <strong>live in its own MuJoCo sim</strong>. Click one to dive in.
      </p>
    </header>
    ${body}`;

  for (const entry of policies) {
    if (!isLiveCapable(entry)) continue;
    const card = root.querySelector<HTMLElement>(`.gcard[data-id="${CSS.escape(entry.id)}"]`);
    if (card) wireLiveCard(card, entry);
  }
}

window.addEventListener('beforeunload', () => {
  for (const h of engines.values()) h.dispose();
});

render();
