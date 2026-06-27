/**
 * Per-policy page.
 *
 * Reads `?id=<policy>` from the URL, looks the policy up in the registry, and
 * mounts the shared Three.js viewport (renderer.ts). Today the viewport shows
 * the robot mesh (or a placeholder) with orbit/grid/lighting.
 *
 * Future wiring (NOT built here):
 *   • playback controls + clip scrubbing → issue wbc-mjlab-3ne
 *   • live mujoco-wasm + onnxruntime-web → M2, via Viewer.mountLiveEngine()
 */

import './styles/app.css';
import { getPolicy } from './registry';
import { Viewer } from './viewer/renderer';

let viewer: Viewer | undefined;

function homeHref(): string {
  return import.meta.env.BASE_URL;
}

function renderNotFound(root: HTMLElement, id: string | null): void {
  root.innerHTML = `
    <p class="back-link"><a href="${homeHref()}">← All policies</a></p>
    <h1>Policy not found</h1>
    <p class="policy-meta">
      ${id ? `No policy with id <code>${escapeHtml(id)}</code>.` : 'No <code>id</code> given in the URL.'}
    </p>`;
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get('id');
  const entry = id ? getPolicy(id) : undefined;

  if (!entry) {
    renderNotFound(root, id);
    return;
  }

  const { manifest, baseUrl } = entry;
  document.title = `${manifest.name} — wbc-demo`;

  root.innerHTML = `
    <div class="policy-header">
      <a class="back-link" href="${homeHref()}">← All policies</a>
      <h1>${escapeHtml(manifest.name)}</h1>
    </div>
    <div class="viewport" id="viewport">
      <div class="viewport-note" id="viewport-note"></div>
    </div>
    ${manifest.description ? `<p class="policy-meta">${escapeHtml(manifest.description)}</p>` : ''}`;

  const container = root.querySelector<HTMLElement>('#viewport');
  if (!container) return;

  // Resolve the robot GLB against the policy folder. None exist yet
  // (issue wbc-mjlab-9as) so the Viewer falls back to a placeholder box.
  const robotUrl = manifest.robot ? `${baseUrl}${manifest.robot}.glb` : undefined;
  viewer = new Viewer(container, { robotUrl });

  const note = root.querySelector<HTMLElement>('#viewport-note');
  if (note) {
    note.textContent = manifest.robot
      ? `loading ${manifest.robot} · live engine arrives in M2`
      : 'robot mesh pending (issue wbc-mjlab-9as) · live engine in M2';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('beforeunload', () => viewer?.dispose());

render();
