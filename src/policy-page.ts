/**
 * Per-policy page — the full live, interactive view.
 *
 * Reads `?id=<policy>` from the URL, looks the policy up in the registry, and
 * mounts the live WBC engine (src/engine/live-engine.ts) full-screen with the
 * telemetry-console HUD + the full control cluster: clip switch, play/pause,
 * reset, speed, policy/open-loop toggle, perturbation (push), and camera
 * reframe. Policies without an ONNX artifact fall back to a metadata card.
 *
 * Issues: wbc-mjlab-e9w (controls), wbc-mjlab-g8h (wire engine into the page).
 */

import './styles/app.css';
import './styles/live.css';
import { getPolicy } from './registry';
import { createLiveEngine, type EngineMode, type LiveStatus, type LiveEngineHandle } from './engine/live-engine';
import type { ReferenceClip } from './spike/policy-config';

let engine: LiveEngineHandle | undefined;

function homeHref(): string {
  return import.meta.env.BASE_URL;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMessage(root: HTMLElement, title: string, body: string): void {
  root.innerHTML = `
    <p class="back-link"><a href="${homeHref()}">← All policies</a></p>
    <h1>${escapeHtml(title)}</h1>
    <p class="policy-meta">${body}</p>`;
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get('id');
  const entry = id ? getPolicy(id) : undefined;
  if (!entry) {
    renderMessage(root, 'Policy not found',
      id ? `No policy with id <code>${escapeHtml(id)}</code>.` : 'No <code>id</code> given in the URL.');
    return;
  }

  const { manifest, baseUrl } = entry;
  document.title = `${manifest.name} — wbc-demo`;

  if (!manifest.artifacts?.onnx) {
    renderMessage(root, manifest.name,
      `${manifest.description ? escapeHtml(manifest.description) + ' ' : ''}` +
      'This policy ships no <code>policy.onnx</code>, so the live engine can’t run it yet.');
    return;
  }
  const robot = manifest.robot ?? 'g1';
  if (robot !== 'g1') {
    renderMessage(root, manifest.name,
      `Live engine assets exist only for <code>g1</code> so far (this policy is <code>${escapeHtml(robot)}</code>).`);
    return;
  }

  root.classList.remove('page'); // full-bleed; drop the centered wrapper
  const ui = buildUi(root, manifest.name);

  const mjcfBaseUrl = `${import.meta.env.BASE_URL}robots/${robot}/mjcf/`;
  createLiveEngine(ui.viewport, {
    policyBaseUrl: baseUrl,
    mjcfBaseUrl,
    follow: true,
    onMessage: (m) => ui.setStatus(m),
    onReady: (clips) => ui.populateClips(clips),
    onStatus: (s) => ui.updateMetrics(s),
    onError: (m) => ui.setStatus(m, true),
  })
    .then((handle) => {
      engine = handle;
      ui.wire(handle);
    })
    .catch((err) => ui.setStatus(String(err), true));
}

// ---- HUD + controls ---------------------------------------------------------
function buildUi(root: HTMLElement, policyName: string) {
  root.innerHTML = `
    <div class="live" id="lv-root" data-state="boot">
      <div class="live__stage" id="lv-viewport"></div>
      <div class="live__vignette" aria-hidden="true"></div>

      <header class="live__topbar">
        <a class="live__back" href="${homeHref()}" title="All policies" aria-label="All policies">←</a>
        <div class="live__brand">
          <span class="live__dot" aria-hidden="true"></span>
          <span class="live__wordmark">${escapeHtml(policyName)}</span>
          <span class="live__state" id="lv-state">boot</span>
        </div>
        <div class="live__status" id="lv-status">booting…</div>
        <div class="live__controls">
          <label class="live__select"><span>clip</span><select id="lv-clip"></select></label>
          <label class="live__select"><span>speed</span>
            <select id="lv-speed">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <button id="lv-mode" class="live__btn" title="Toggle the policy on/off">policy</button>
          <button id="lv-push" class="live__btn" title="Shove the robot">push</button>
          <button id="lv-cam" class="live__btn" title="Re-frame camera">reframe</button>
          <button id="lv-play" class="live__btn live__btn--primary">⏸&nbsp;pause</button>
          <button id="lv-reset" class="live__btn">↺&nbsp;reset</button>
        </div>
      </header>

      <footer class="live__telemetry" id="lv-metrics"></footer>
      <div class="live__progress" aria-hidden="true"><span id="lv-progress"></span></div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const rootEl = $('#lv-root');
  const viewport = $<HTMLElement>('#lv-viewport');
  const statusEl = $('#lv-status');
  const stateEl = $('#lv-state');
  const metricsEl = $('#lv-metrics');
  const progressEl = $('#lv-progress');
  const clipEl = $<HTMLSelectElement>('#lv-clip');
  const speedEl = $<HTMLSelectElement>('#lv-speed');
  const modeEl = $<HTMLButtonElement>('#lv-mode');
  const pushEl = $<HTMLButtonElement>('#lv-push');
  const camEl = $<HTMLButtonElement>('#lv-cam');
  const playEl = $<HTMLButtonElement>('#lv-play');
  const resetEl = $<HTMLButtonElement>('#lv-reset');

  let latest: LiveStatus | undefined;
  let playing = true;
  let mode: EngineMode = 'policy';

  function renderState(): void {
    let state = 'live', label = 'live';
    if (latest?.error) { state = 'fell'; label = 'error'; }
    else if (mode === 'open-loop' && latest?.ready) { state = 'paused'; label = 'open-loop'; }
    else if (latest?.fell) { state = 'fell'; label = 'fell'; }
    else if (!latest?.ready) { state = 'boot'; label = 'boot'; }
    else if (!playing) { state = 'paused'; label = 'paused'; }
    rootEl.dataset.state = state;
    stateEl.textContent = label;
  }

  return {
    viewport,
    setStatus(s: string, err = false) {
      statusEl.textContent = s;
      statusEl.style.color = err ? 'var(--color-danger)' : '';
      if (err) { rootEl.dataset.state = 'fell'; stateEl.textContent = 'error'; }
    },
    populateClips(clips: ReferenceClip[]) {
      const current = latest?.clipId;
      clipEl.innerHTML = clips
        .map((c) => `<option value="${c.id}"${c.id === current ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
        .join('');
    },
    updateMetrics(s: LiveStatus) {
      latest = s;
      playing = s.playing;
      renderState();
      metricsEl.innerHTML = [
        tm('realtime', s.realtime != null ? `${s.realtime}×` : '…', toneRealtime(s.realtime)),
        tm('speed', `${s.speed}×`),
        tm('ctrl', s.controlHz != null ? `${s.controlHz} Hz` : '…'),
        tm('fps', s.fps ?? '…'),
        tm('infer', s.inferMs != null ? `${s.inferMs} ms` : '…'),
        tm('upright', s.upright != null ? s.upright.toFixed(2) : '…', toneUpright(s.upright)),
        tm('pelvis z', s.pelvisHeight != null ? `${s.pelvisHeight} m` : '…', tonePelvis(s.pelvisHeight)),
        tm('frame', s.clipFrame != null ? `${s.clipFrame}/${s.clipFrames}` : '…'),
        tm('mode', s.mode),
        tm('load', s.loadMs != null ? `${s.loadMs} ms` : '…'),
      ].join('');
      if (s.clipFrame != null && s.clipFrames) {
        progressEl.style.width = `${((s.clipFrame / s.clipFrames) * 100).toFixed(1)}%`;
      }
      if (clipEl.value !== s.clipId && s.clipId) clipEl.value = s.clipId;
    },
    wire(h: LiveEngineHandle) {
      clipEl.addEventListener('change', () => void h.selectClip(clipEl.value));
      speedEl.addEventListener('change', () => h.setSpeed(parseFloat(speedEl.value)));
      modeEl.addEventListener('click', () => {
        mode = mode === 'policy' ? 'open-loop' : 'policy';
        h.setMode(mode);
        modeEl.textContent = mode;
        modeEl.classList.toggle('live__btn--warn', mode === 'open-loop');
        renderState();
      });
      pushEl.addEventListener('click', () => h.perturb());
      camEl.addEventListener('click', () => h.reframe());
      resetEl.addEventListener('click', () => h.reset());
      playEl.addEventListener('click', () => {
        playing = h.toggle();
        playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
        renderState();
      });
    },
  };
}

function tm(k: string, v: unknown, tone = ''): string {
  const attr = tone ? ` data-tone="${tone}"` : '';
  return `<div class="tm"${attr}><span class="tm__k">${k}</span><span class="tm__v">${v}</span></div>`;
}
function toneRealtime(x: number | null): string {
  if (x == null) return '';
  return x >= 0.9 ? 'ok' : x >= 0.5 ? 'warn' : 'bad';
}
function toneUpright(x: number | null): string {
  if (x == null) return '';
  return x <= -0.85 ? 'ok' : x <= -0.5 ? 'warn' : 'bad';
}
function tonePelvis(x: number | null): string {
  if (x == null) return '';
  return x > 0.6 ? 'ok' : x >= 0.45 ? 'warn' : 'bad';
}

window.addEventListener('beforeunload', () => engine?.dispose());

render();
