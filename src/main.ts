/**
 * Gallery landing page.
 *
 * Lists every policy discovered from `policies/*` at build time (see
 * registry.ts) as a card linking to its per-policy page. Auto-populates from
 * committed policy folders with zero code edits.
 */

import './styles/app.css';
import { discoverPolicies } from './registry';
import type { PolicyEntry } from './types';

const EXAMPLE_ID = '_example';

/** Build the per-policy page URL for a given policy id (Vite-base aware). */
function policyHref(id: string): string {
  return `${import.meta.env.BASE_URL}policy.html?id=${encodeURIComponent(id)}`;
}

function renderCard(entry: PolicyEntry): string {
  const { manifest, baseUrl } = entry;
  const isExample = entry.id === EXAMPLE_ID;

  const thumb = manifest.thumbnail
    ? `<img src="${baseUrl}${manifest.thumbnail}" alt="" loading="lazy" />`
    : 'no thumbnail';

  const tags = (manifest.tags ?? [])
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');

  const exampleBadge = isExample
    ? '<span class="badge-example" title="Remove once real policies land">example</span>'
    : '';

  return `
    <a class="card" href="${policyHref(entry.id)}">
      <div class="card__thumb">${thumb}</div>
      <div class="card__body">
        <h2 class="card__title">${escapeHtml(manifest.name)}${exampleBadge}</h2>
        ${manifest.description ? `<p class="card__desc">${escapeHtml(manifest.description)}</p>` : ''}
        ${tags ? `<div>${tags}</div>` : ''}
      </div>
    </a>`;
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const policies = discoverPolicies();

  const body = policies.length
    ? `<div class="gallery">${policies.map(renderCard).join('')}</div>`
    : `<p class="empty">No policies found. Add one under <code>policies/&lt;id&gt;/policy.yaml</code> and open a PR.</p>`;

  root.innerHTML = `
    <header class="site-header">
      <h1>wbc-mjlab policy demos</h1>
      <p>
        Interactive in-browser showcase of whole-body-control policies.
        Each card is a policy discovered from the <code>policies/</code> directory.
      </p>
    </header>
    ${body}`;
}

/** Minimal HTML-escaping for manifest-sourced strings injected via innerHTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

render();
