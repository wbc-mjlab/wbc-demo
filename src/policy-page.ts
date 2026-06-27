/**
 * Live demo page — full-screen interactive view (site landing + deep links).
 *
 * Opens at `/` with the default live policy and manifest default clip (idle),
 * or reads `?id=<policy>&clip=<clip>` from the URL. Back arrow → clip gallery.
 * mounts the live WBC engine (src/engine/live-engine.ts) full-screen with the
 * telemetry-console HUD + the full control cluster: clip switch, play/pause,
 * reset, speed, policy/open-loop toggle, perturbation (push), and camera follow.
 */

import './styles/app.css';
import './styles/live.css';
import { getDefaultLivePolicy, getPolicy } from './registry';
import { createLiveEngine, type EngineMode, type LiveStatus, type LiveEngineHandle } from './engine/live-engine';
import type { ReferenceClip } from './engine/policy-config';

let engine: LiveEngineHandle | undefined;
let keyHandlerCleanup: (() => void) | undefined;

function galleryHref(): string {
  return `${import.meta.env.BASE_URL}gallery.html`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMessage(root: HTMLElement, title: string, body: string): void {
  root.innerHTML = `
    <p class="back-link"><a href="${galleryHref()}">← All clips</a></p>
    <h1>${escapeHtml(title)}</h1>
    <p class="policy-meta">${body}</p>`;
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') ?? getDefaultLivePolicy()?.id;
  const startClip = params.get('clip') ?? undefined;
  const entry = id ? getPolicy(id) : undefined;
  if (!entry) {
    renderMessage(root, 'Policy not found',
      id ? `No policy with id <code>${escapeHtml(id)}</code>.` : 'No live policy is available.');
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
    startClipId: startClip,
    autoplay: true,
    follow: true,
    interactiveDrag: true,
    onMessage: (m) => ui.setStatus(m),
    onReady: (clips) => ui.populateClips(clips),
    onStatus: (s) => ui.updateMetrics(s),
    onFsm: (s) => ui.updateFsm(s),
    onError: (m) => ui.setStatus(m, true),
  })
    .then((handle) => {
      engine = handle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__engine = handle; // diagnostics hook
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
        <a class="live__back" href="${galleryHref()}" title="All clips" aria-label="All clips">←</a>
        <div class="live__brand">
          <span class="live__dot" aria-hidden="true"></span>
          <span class="live__wordmark">${escapeHtml(policyName)}</span>
          <span class="live__state" id="lv-state">boot</span>
        </div>
        <div class="live__status" id="lv-status">booting…</div>
        <div class="live__controls">
          <label class="live__select"><span>clip</span><select id="lv-clip"></select></label>
          <button id="lv-prev" class="live__btn" title="Previous clip (←)">◀</button>
          <button id="lv-next" class="live__btn" title="Next clip (→)">▶</button>
          <button id="lv-getup" class="live__btn" title="Get up from floor (↑)">get up</button>
          <button id="lv-liedown" class="live__btn" title="Lie down when idle (↓)">lie down</button>
          <label class="live__select"><span>speed</span>
            <select id="lv-speed">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <button id="lv-mode" class="live__btn" title="Toggle policy on/off (P)">policy</button>
          <button id="lv-push" class="live__btn" title="Shove the robot">push</button>
          <button id="lv-follow" class="live__btn" title="Follow robot (F)" aria-pressed="true">follow</button>
          <button id="lv-loop" class="live__btn" title="Loop clip" aria-pressed="false">loop</button>
          <button id="lv-play" class="live__btn live__btn--primary" title="Play / pause (Space)">⏸&nbsp;pause</button>
          <button id="lv-reset" class="live__btn" title="Reset (R)">↺&nbsp;reset</button>
        </div>
      </header>

      <details class="live__keys" id="lv-keys" open>
        <summary class="live__keys-toggle">controls</summary>
        <table class="live__keys-table">
          <tbody>
            <tr><th scope="row"><kbd>Space</kbd></th><td>Play / pause</td></tr>
            <tr><th scope="row"><kbd>R</kbd></th><td>Reset clip</td></tr>
            <tr><th scope="row"><kbd>←</kbd> <kbd>→</kbd></th><td>Previous / next clip (auto-play)</td></tr>
            <tr><th scope="row"><kbd>↑</kbd> <kbd>↓</kbd></th><td>Get up / lie down</td></tr>
            <tr><th scope="row"><kbd>F</kbd></th><td>Toggle follow</td></tr>
            <tr><th scope="row"><kbd>P</kbd></th><td>Policy on / off</td></tr>
            <tr><th scope="row"><kbd>?</kbd></th><td>Show / hide this panel</td></tr>
            <tr><th scope="row">Clip picker</th><td>Auto-play on change</td></tr>
            <tr><th scope="row">Loop</th><td>Repeat clip when finished</td></tr>
            <tr><th scope="row">Drag</th><td>Perturb robot</td></tr>
          </tbody>
        </table>
      </details>

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
  const prevEl = $<HTMLButtonElement>('#lv-prev');
  const nextEl = $<HTMLButtonElement>('#lv-next');
  const getupEl = $<HTMLButtonElement>('#lv-getup');
  const liedownEl = $<HTMLButtonElement>('#lv-liedown');
  const speedEl = $<HTMLSelectElement>('#lv-speed');
  const modeEl = $<HTMLButtonElement>('#lv-mode');
  const pushEl = $<HTMLButtonElement>('#lv-push');
  const followEl = $<HTMLButtonElement>('#lv-follow');
  const loopEl = $<HTMLButtonElement>('#lv-loop');
  const playEl = $<HTMLButtonElement>('#lv-play');
  const resetEl = $<HTMLButtonElement>('#lv-reset');
  const keysEl = $<HTMLDetailsElement>('#lv-keys');

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
    updateFsm(s: LiveStatus) {
      clipEl.disabled = !s.canBrowse;
      prevEl.disabled = !s.canBrowse;
      nextEl.disabled = !s.canBrowse;
      getupEl.disabled = !s.canGetup;
      liedownEl.disabled = !s.canLiedown;
    },
    updateMetrics(s: LiveStatus) {
      latest = s;
      playing = s.playing;
      playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
      loopEl.setAttribute('aria-pressed', String(s.loop));
      renderState();
      this.updateFsm(s);
      metricsEl.innerHTML = [
        tm('fsm', s.fsmLabel),
        tm('pose', s.robotIsUp ? 'up' : 'down', s.robotIsUp ? 'ok' : 'warn'),
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
      let following = true;

      const syncModeButton = (): void => {
        modeEl.textContent = mode;
        modeEl.classList.toggle('live__btn--warn', mode === 'open-loop');
        renderState();
      };

      const syncFollowButton = (): void => {
        followEl.setAttribute('aria-pressed', String(following));
        followEl.title = following ? 'Follow on (F)' : 'Follow off (F)';
      };

      clipEl.addEventListener('change', () => void h.selectClip(clipEl.value));
      prevEl.addEventListener('click', () => void h.browsePrevClip());
      nextEl.addEventListener('click', () => void h.browseNextClip());
      getupEl.addEventListener('click', () => void h.triggerGetup());
      liedownEl.addEventListener('click', () => void h.triggerLiedown());
      speedEl.addEventListener('change', () => h.setSpeed(parseFloat(speedEl.value)));
      modeEl.addEventListener('click', () => {
        mode = mode === 'policy' ? 'open-loop' : 'policy';
        h.setMode(mode);
        syncModeButton();
      });
      pushEl.addEventListener('click', () => h.perturb());
      followEl.addEventListener('click', () => {
        following = !following;
        h.setFollow(following);
        syncFollowButton();
      });
      loopEl.addEventListener('click', () => {
        const on = loopEl.getAttribute('aria-pressed') !== 'true';
        h.setLoop(on);
        loopEl.setAttribute('aria-pressed', String(on));
      });
      resetEl.addEventListener('click', () => h.reset());
      playEl.addEventListener('click', () => {
        playing = h.toggle();
        playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
        renderState();
      });

      syncFollowButton();

      const onKey = (e: KeyboardEvent): void => {
        if (e.repeat) return;
        const el = e.target;
        if (!(el instanceof HTMLElement)) return;
        if (el.isContentEditable) return;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        switch (e.code) {
          case 'KeyR':
            e.preventDefault();
            h.reset();
            break;
          case 'Space':
            e.preventDefault();
            playing = h.toggle();
            playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
            renderState();
            break;
          case 'ArrowLeft':
            e.preventDefault();
            if (!prevEl.disabled) void h.browsePrevClip();
            break;
          case 'ArrowRight':
            e.preventDefault();
            if (!nextEl.disabled) void h.browseNextClip();
            break;
          case 'ArrowUp':
            e.preventDefault();
            if (!getupEl.disabled) void h.triggerGetup();
            break;
          case 'ArrowDown':
            e.preventDefault();
            if (!liedownEl.disabled) void h.triggerLiedown();
            break;
          case 'KeyF':
            e.preventDefault();
            following = !following;
            h.setFollow(following);
            syncFollowButton();
            break;
          case 'KeyP':
            e.preventDefault();
            mode = mode === 'policy' ? 'open-loop' : 'policy';
            h.setMode(mode);
            syncModeButton();
            break;
          default:
            if (e.key === '?') {
              e.preventDefault();
              keysEl.open = !keysEl.open;
            }
            return;
        }
      };

      keyHandlerCleanup?.();
      window.addEventListener('keydown', onKey);
      keyHandlerCleanup = () => window.removeEventListener('keydown', onKey);
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

window.addEventListener('beforeunload', () => {
  keyHandlerCleanup?.();
  engine?.dispose();
});

render();
