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
import { createLiveEngine, type EngineMode, type LiveStatus, type LiveEngineHandle, type RefSource } from './engine/live-engine';
import type { ReferenceClip } from './engine/policy-config';
import type { PolicyLinks } from './types';

const DEMO_REPO_URL = 'https://github.com/wbc-mjlab/wbc-demo';

let engine: LiveEngineHandle | undefined;
let keyHandlerCleanup: (() => void) | undefined;

function galleryHref(): string {
  return `${import.meta.env.BASE_URL}gallery.html`;
}

function githubHref(links?: PolicyLinks): string {
  for (const url of [links?.code, links?.paper]) {
    if (url?.includes('github.com')) return url;
  }
  return links?.code ?? DEMO_REPO_URL;
}

const GITHUB_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.18.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.51-1.04 2.18-.82 2.18-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

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
  const ui = buildUi(root, manifest.name, githubHref(manifest.links));

  const mjcfBaseUrl = `${import.meta.env.BASE_URL}robots/${robot}/mjcf/`;
  const genRel = manifest.artifacts?.gen;
  const genParamsBaseUrl = genRel
    ? `${baseUrl}${genRel.endsWith('/') ? genRel : `${genRel}/`}`
    : undefined;
  createLiveEngine(ui.viewport, {
    policyBaseUrl: baseUrl,
    mjcfBaseUrl,
    genParamsBaseUrl,
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
function buildUi(root: HTMLElement, policyName: string, repoUrl: string) {
  root.innerHTML = `
    <div class="live" id="lv-root" data-state="boot">
      <div class="live__stage" id="lv-viewport"></div>
      <div class="live__vignette" aria-hidden="true"></div>

      <header class="live__topbar">
        <a class="live__back" href="${galleryHref()}" title="All clips" aria-label="All clips">←</a>
        <a class="live__back live__github" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer" title="View on GitHub" aria-label="View on GitHub">${GITHUB_ICON}</a>
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
          <button id="lv-gen" class="live__btn" title="Generator locomotion (G)" aria-pressed="false" disabled>gen</button>
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
          <button id="lv-chase" class="live__btn" title="Chase cam (V)" aria-pressed="false">chase</button>
          <button id="lv-loop" class="live__btn" title="Loop clip" aria-pressed="false">loop</button>
          <button id="lv-play" class="live__btn live__btn--primary" title="Play / pause (Space)">⏸&nbsp;pause</button>
          <button id="lv-reset" class="live__btn" title="Reset sim pose (R)">↺&nbsp;reset</button>
        </div>
      </header>

      <details class="live__keys" id="lv-keys" open>
        <summary class="live__keys-toggle">controls</summary>
        <div class="live__keys-body">
          <section class="live__keys-pane" aria-labelledby="lv-keys-general">
            <h3 class="live__keys-heading" id="lv-keys-general">General</h3>
            <table class="live__keys-table">
              <tbody>
                <tr><th scope="row"><kbd>Space</kbd></th><td>Play / pause clip (crouch in Gen)</td></tr>
                <tr><th scope="row"><kbd>R</kbd></th><td>Reset sim pose</td></tr>
                <tr><th scope="row"><kbd>F</kbd></th><td>Toggle camera follow</td></tr>
                <tr><th scope="row"><kbd>V</kbd></th><td>Toggle chase cam</td></tr>
                <tr><th scope="row"><kbd>P</kbd></th><td>Policy on / off</td></tr>
                <tr><th scope="row"><kbd>?</kbd></th><td>Show / hide this panel</td></tr>
                <tr><th scope="row">Drag</th><td>Perturb robot</td></tr>
              </tbody>
            </table>
          </section>

          <section class="live__keys-pane" aria-labelledby="lv-keys-clips">
            <h3 class="live__keys-heading" id="lv-keys-clips">Clips</h3>
            <table class="live__keys-table">
              <tbody>
                <tr><th scope="row"><kbd>←</kbd> <kbd>→</kbd></th><td>Previous / next clip</td></tr>
                <tr><th scope="row"><kbd>↑</kbd></th><td>Get up (when down)</td></tr>
                <tr><th scope="row"><kbd>↓</kbd></th><td>Lie down (when idle)</td></tr>
                <tr><th scope="row">Loop</th><td>Repeat clip when finished</td></tr>
              </tbody>
            </table>
          </section>

          <section class="live__keys-pane live__keys-pane--gen" id="lv-keys-gen" aria-labelledby="lv-keys-gen-title">
            <h3 class="live__keys-heading" id="lv-keys-gen-title">
              Generator
              <span class="live__keys-badge" id="lv-keys-gen-badge">off</span>
            </h3>
            <p class="live__keys-note">Press <kbd>G</kbd> or the <strong>gen</strong> button to enter. Standing only.</p>
            <table class="live__keys-table">
              <tbody>
                <tr><th scope="row"><kbd>G</kbd></th><td>Toggle Gen ↔ clips</td></tr>
                <tr><th scope="row"><kbd>W</kbd> <kbd>S</kbd></th><td>Forward / back</td></tr>
                <tr><th scope="row"><kbd>Q</kbd> <kbd>E</kbd></th><td>Strafe left / right</td></tr>
                <tr><th scope="row"><kbd>A</kbd> <kbd>D</kbd></th><td>Yaw left / right</td></tr>
                <tr><th scope="row"><kbd>Shift</kbd></th><td>Sprint (lower torso + faster)</td></tr>
                <tr><th scope="row"><kbd>Space</kbd></th><td>Crouch (lower torso + slower)</td></tr>
              </tbody>
            </table>
          </section>
        </div>
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
  const genEl = $<HTMLButtonElement>('#lv-gen');
  const speedEl = $<HTMLSelectElement>('#lv-speed');
  const modeEl = $<HTMLButtonElement>('#lv-mode');
  const pushEl = $<HTMLButtonElement>('#lv-push');
  const followEl = $<HTMLButtonElement>('#lv-follow');
  const chaseEl = $<HTMLButtonElement>('#lv-chase');
  const loopEl = $<HTMLButtonElement>('#lv-loop');
  const playEl = $<HTMLButtonElement>('#lv-play');
  const resetEl = $<HTMLButtonElement>('#lv-reset');
  const keysEl = $<HTMLDetailsElement>('#lv-keys');
  const genPaneEl = $<HTMLElement>('#lv-keys-gen');
  const genBadgeEl = $<HTMLElement>('#lv-keys-gen-badge');

  let latest: LiveStatus | undefined;
  let playing = true;
  let mode: EngineMode = 'policy';
  let refSource: RefSource = 'clips';

  function renderState(): void {
    let state = 'live', label = 'live';
    if (latest?.error) { state = 'fell'; label = 'error'; }
    else if (refSource === 'gen' && latest?.ready) { state = 'live'; label = 'gen'; }
    else if (mode === 'open-loop' && latest?.ready) { state = 'paused'; label = 'open-loop'; }
    else if (latest?.fell) { state = 'fell'; label = 'fell'; }
    else if (!latest?.ready) { state = 'boot'; label = 'boot'; }
    else if (!playing) { state = 'paused'; label = 'paused'; }
    rootEl.dataset.state = state;
    stateEl.textContent = label;
  }

  function syncGenButton(): void {
    const avail = latest?.genAvailable === true;
    const down = latest != null && !latest.robotIsUp;
    genEl.disabled = !avail || (down && refSource !== 'gen');
    genEl.setAttribute('aria-pressed', String(refSource === 'gen'));
    genEl.classList.toggle('live__btn--warn', refSource === 'gen');
    genEl.textContent = refSource === 'gen' ? 'clips' : 'gen';
    genEl.title = refSource === 'gen'
      ? 'Leave Generator → clips (G)'
      : 'Enter Generator locomotion (G)';

    const genOn = refSource === 'gen';
    genPaneEl.dataset.active = genOn ? 'true' : 'false';
    genBadgeEl.textContent = !avail ? 'n/a' : genOn ? 'on' : 'off';
    genBadgeEl.dataset.tone = !avail ? 'muted' : genOn ? 'on' : 'off';
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
      refSource = s.refSource;
      clipEl.disabled = !s.canBrowse;
      prevEl.disabled = !s.canBrowse;
      nextEl.disabled = !s.canBrowse;
      getupEl.disabled = !s.canGetup;
      liedownEl.disabled = !s.canLiedown;
      syncGenButton();
    },
    updateMetrics(s: LiveStatus) {
      latest = s;
      playing = s.playing;
      refSource = s.refSource;
      playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
      loopEl.setAttribute('aria-pressed', String(s.loop));
      renderState();
      this.updateFsm(s);
      const metrics = [
        tm('fsm', s.fsmLabel),
        tm('ref', s.refSource),
        tm('pose', s.robotIsUp ? 'up' : 'down', s.robotIsUp ? 'ok' : 'warn'),
        tm('realtime', s.realtime != null ? `${s.realtime}×` : '…', toneRealtime(s.realtime)),
        tm('speed', `${s.speed}×`),
        tm('ctrl', s.controlHz != null ? `${s.controlHz} Hz` : '…'),
        tm('fps', s.fps ?? '…'),
        tm('infer', s.inferMs != null ? `${s.inferMs} ms` : '…'),
        tm('upright', s.upright != null ? s.upright.toFixed(2) : '…', toneUpright(s.upright)),
        tm('pelvis z', s.pelvisHeight != null ? `${s.pelvisHeight} m` : '…', tonePelvis(s.pelvisHeight)),
      ];
      if (s.refSource === 'gen') {
        metrics.push(
          tm('vx', s.genVx ?? '…'),
          tm('vy', s.genVy ?? '…'),
          tm('wz', s.genWz ?? '…'),
          tm('h', s.genHeight != null ? `${s.genHeight} m` : '…'),
        );
      } else {
        metrics.push(tm('frame', s.clipFrame != null ? `${s.clipFrame}/${s.clipFrames}` : '…'));
      }
      metrics.push(
        tm('mode', s.mode),
        tm('load', s.loadMs != null ? `${s.loadMs} ms` : '…'),
      );
      metricsEl.innerHTML = metrics.join('');
      if (s.clipFrame != null && s.clipFrames && s.refSource === 'clips') {
        progressEl.style.width = `${((s.clipFrame / s.clipFrames) * 100).toFixed(1)}%`;
      } else if (s.refSource === 'gen') {
        progressEl.style.width = '100%';
      }
      if (clipEl.value !== s.clipId && s.clipId) clipEl.value = s.clipId;
    },
    wire(h: LiveEngineHandle) {
      let following = true;
      let chasing = false;

      const syncModeButton = (): void => {
        modeEl.textContent = mode;
        modeEl.classList.toggle('live__btn--warn', mode === 'open-loop');
        renderState();
      };

      const syncFollowButton = (): void => {
        followEl.setAttribute('aria-pressed', String(following && !chasing));
        followEl.disabled = chasing;
        followEl.title = chasing
          ? 'Follow (disabled in chase — press V)'
          : following ? 'Follow on (F)' : 'Follow off (F)';
      };

      const syncChaseButton = (): void => {
        chaseEl.setAttribute('aria-pressed', String(chasing));
        chaseEl.classList.toggle('live__btn--warn', chasing);
        chaseEl.textContent = chasing ? 'orbit' : 'chase';
        chaseEl.title = chasing
          ? 'Leave chase → orbit (V)'
          : 'Chase cam behind robot (V)';
        syncFollowButton();
      };

      const syncTeleopFromKeys = (keys: Set<string>): void => {
        if (refSource !== 'gen') {
          h.setGenTeleop({
            forward: 0,
            strafe: 0,
            yaw: 0,
            sprint: false,
            crouch: false,
          });
          return;
        }
        const forward = (keys.has('KeyW') ? 1 : 0) + (keys.has('KeyS') ? -1 : 0);
        const strafe = (keys.has('KeyQ') ? 1 : 0) + (keys.has('KeyE') ? -1 : 0);
        const yaw = (keys.has('KeyA') ? 1 : 0) + (keys.has('KeyD') ? -1 : 0);
        const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const crouch = keys.has('Space');
        h.setGenTeleop({ forward, strafe, yaw, sprint, crouch });
      };

      const heldKeys = new Set<string>();

      clipEl.addEventListener('change', () => void h.selectClip(clipEl.value));
      prevEl.addEventListener('click', () => void h.browsePrevClip());
      nextEl.addEventListener('click', () => void h.browseNextClip());
      getupEl.addEventListener('click', () => void h.triggerGetup());
      liedownEl.addEventListener('click', () => void h.triggerLiedown());
      genEl.addEventListener('click', () => {
        void h.toggleGen().then((on) => {
          refSource = on ? 'gen' : 'clips';
          syncGenButton();
          renderState();
        });
      });
      speedEl.addEventListener('change', () => h.setSpeed(parseFloat(speedEl.value)));
      modeEl.addEventListener('click', () => {
        mode = mode === 'policy' ? 'open-loop' : 'policy';
        h.setMode(mode);
        syncModeButton();
      });
      pushEl.addEventListener('click', () => h.perturb());
      followEl.addEventListener('click', () => {
        if (chasing) return;
        following = !following;
        h.setFollow(following);
        syncFollowButton();
      });
      chaseEl.addEventListener('click', () => {
        chasing = h.toggleChase();
        if (chasing) following = true;
        syncChaseButton();
      });
      loopEl.addEventListener('click', () => {
        const on = loopEl.getAttribute('aria-pressed') !== 'true';
        h.setLoop(on);
        loopEl.setAttribute('aria-pressed', String(on));
      });
      resetEl.addEventListener('click', () => h.reset());
      playEl.addEventListener('click', () => {
        if (refSource === 'gen') return; // Gen always runs
        playing = h.toggle();
        playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
        renderState();
      });

      syncFollowButton();
      syncChaseButton();
      syncGenButton();

      const onKeyDown = (e: KeyboardEvent): void => {
        const el = e.target;
        if (!(el instanceof HTMLElement)) return;
        if (el.isContentEditable) return;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        // Continuous Gen teleop (allow repeats for held keys via Set).
        const teleopCodes = [
          'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
          'ShiftLeft', 'ShiftRight', 'Space',
        ];
        if (teleopCodes.includes(e.code) && (e.code !== 'Space' || refSource === 'gen')) {
          heldKeys.add(e.code);
          syncTeleopFromKeys(heldKeys);
          if (refSource === 'gen') e.preventDefault();
          return;
        }

        if (e.repeat) return;

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
            if (refSource !== 'gen' && !getupEl.disabled) void h.triggerGetup();
            break;
          case 'ArrowDown':
            e.preventDefault();
            if (refSource !== 'gen' && !liedownEl.disabled) void h.triggerLiedown();
            break;
          case 'KeyG':
            e.preventDefault();
            void h.toggleGen().then((on) => {
              refSource = on ? 'gen' : 'clips';
              heldKeys.clear();
              syncTeleopFromKeys(heldKeys);
              syncGenButton();
              renderState();
            });
            break;
          case 'KeyF':
            e.preventDefault();
            if (chasing) break;
            following = !following;
            h.setFollow(following);
            syncFollowButton();
            break;
          case 'KeyV':
            e.preventDefault();
            chasing = h.toggleChase();
            if (chasing) following = true;
            syncChaseButton();
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

      const onKeyUp = (e: KeyboardEvent): void => {
        if (heldKeys.delete(e.code)) syncTeleopFromKeys(heldKeys);
      };

      keyHandlerCleanup?.();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      keyHandlerCleanup = () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      };
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
