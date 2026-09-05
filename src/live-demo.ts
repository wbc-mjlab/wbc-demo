/**
 * Shared live-demo HUD — used by the main landing page and the tracking page.
 *
 * Modes:
 *  - live: Generator starts on when Gen assets exist (teleop / stick).
 *  - tracking: clip reference tracking only (shareable URL for reference mode).
 *
 * Chrome:
 *  - full: dense control cluster (desktop default).
 *  - minimal: trajectory dropdown + essentials; default on mobile / coarse pointer.
 *    In Gen on mobile, a virtual stick + sprint/crouch (and yaw) pad replaces WASD.
 */

import './styles/app.css';
import './styles/live.css';
import { getDefaultLivePolicy, getPolicy } from './registry';
import {
  createLiveEngine,
  type EngineMode,
  type LiveStatus,
  type LiveEngineHandle,
  type RefSource,
} from './engine/live-engine';
import type { ReferenceClip } from './engine/policy-config';
import type { PolicyLinks } from './types';
import {
  THEME_EVENT,
  initTheme,
  themeToggleHtml,
  wireThemeToggle,
} from './theme';
import { preferLowQualityGl } from './platform';

export type DemoPageKind = 'live' | 'tracking';

export interface DemoPageOptions {
  kind: DemoPageKind;
}

const DEMO_REPO_URL = 'https://github.com/wbc-mjlab/wbc-demo';

let engine: LiveEngineHandle | undefined;
let keyHandlerCleanup: (() => void) | undefined;
let padCleanup: (() => void) | undefined;

function galleryHref(): string {
  return `${import.meta.env.BASE_URL}gallery.html`;
}

function liveHref(params?: URLSearchParams): string {
  const q = params?.toString();
  return q ? `${import.meta.env.BASE_URL}?${q}` : import.meta.env.BASE_URL;
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

/** Prefer touch-friendly minimal chrome on phones/tablets. */
export function preferMinimalChrome(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  const touchPoints = navigator.maxTouchPoints > 0;
  return coarse || (narrow && touchPoints) || narrow;
}

const PAD_PREF_KEY = 'wbc-demo-pad';

/** On-screen stick default: on for mobile, off for desktop; overridable via storage / ?pad=. */
export function preferMobilePad(): boolean {
  try {
    const stored = localStorage.getItem(PAD_PREF_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch { /* ignore */ }
  return preferMinimalChrome();
}

function savePadPref(on: boolean): void {
  try {
    localStorage.setItem(PAD_PREF_KEY, on ? 'on' : 'off');
  } catch { /* ignore */ }
}

function renderMessage(root: HTMLElement, title: string, body: string): void {
  root.innerHTML = `
    <p class="back-link"><a href="${galleryHref()}">← All clips</a></p>
    <h1>${escapeHtml(title)}</h1>
    <p class="policy-meta">${body}</p>`;
}

export function bootDemoPage(opts: DemoPageOptions): void {
  initTheme();

  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') ?? getDefaultLivePolicy()?.id;
  const startClip = params.get('clip') ?? undefined;
  const chromeParam = params.get('chrome');
  const padParam = params.get('pad');
  const hudParam = params.get('hud');
  const modeParam = params.get('mode') ?? params.get('gen');
  const lockParam = params.get('lock');
  const switchParam = params.get('switch');
  const mobile = preferMinimalChrome();
  const entry = id ? getPolicy(id) : undefined;
  if (!entry) {
    renderMessage(root, 'Policy not found',
      id ? `No policy with id <code>${escapeHtml(id)}</code>.` : 'No live policy is available.');
    return;
  }

  const { manifest, baseUrl } = entry;
  const tracking = opts.kind === 'tracking';
  document.title = tracking
    ? `${manifest.name} — tracking — wbc-demo`
    : `${manifest.name} — wbc-demo`;

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

  let chrome: 'full' | 'minimal' =
    chromeParam === 'full' || chromeParam === 'minimal'
      ? chromeParam
      : 'minimal';
  const padEnabled =
    padParam === 'on' ? true
      : padParam === 'off' ? false
        : preferMobilePad();
  // Mobile defaults: tracking + HUD hidden. Override with ?hud=on|off and
  // ?mode=gen|tracking (or ?gen=1|0). ?lock=gen hides the mode switch (and G).
  const startHudVisible =
    hudParam === 'off' ? false
      : hudParam === 'on' ? true
        : !mobile;
  let startInGen: boolean | undefined;
  if (tracking) {
    startInGen = false;
  } else if (
    modeParam === '0' || modeParam === 'off' || modeParam === 'false'
    || modeParam === 'tracking' || modeParam === 'clips'
  ) {
    startInGen = false;
  } else if (
    modeParam === '1' || modeParam === 'on' || modeParam === 'true'
    || modeParam === 'gen' || modeParam === 'generator'
  ) {
    startInGen = true;
  } else {
    startInGen = mobile ? false : undefined;
  }
  const lockGen = !tracking && (
    lockParam === 'gen' || lockParam === 'generator'
    || switchParam === 'off'
  );
  if (lockGen) startInGen = true;

  root.classList.remove('page');
  const ui = buildUi(root, {
    policyName: manifest.name,
    repoUrl: githubHref(manifest.links),
    kind: opts.kind,
    chrome,
    padEnabled,
    startHudVisible,
    lockGen,
    onChromeChange: (next) => { chrome = next; },
  });

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
    lowQuality: preferLowQualityGl(),
    startInGen,
    onMessage: (m) => ui.setStatus(m),
    onReady: (clips) => ui.populateClips(clips),
    onStatus: (s) => ui.updateMetrics(s),
    onFsm: (s) => ui.updateFsm(s),
    onError: (m) => ui.setStatus(m, true),
  })
    .then((handle) => {
      engine = handle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__engine = handle;
      ui.wire(handle);
      let resumeOnVisible = handle.status.playing;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          resumeOnVisible = handle.status.playing;
          handle.pause();
        } else if (resumeOnVisible) {
          handle.play();
        }
      });
    })
    .catch((err) => ui.setStatus(String(err), true));
}

interface BuildUiOpts {
  policyName: string;
  repoUrl: string;
  kind: DemoPageKind;
  chrome: 'full' | 'minimal';
  padEnabled: boolean;
  startHudVisible: boolean;
  lockGen: boolean;
  onChromeChange: (chrome: 'full' | 'minimal') => void;
}

function buildUi(root: HTMLElement, opts: BuildUiOpts) {
  const tracking = opts.kind === 'tracking';
  const lockGen = opts.lockGen;
  // Live page: in-page Gen ↔ tracking toggle. Tracking page: link out to Gen demo.
  const modeControl = tracking
    ? `<a class="live__mode-link" href="${liveHref(new URLSearchParams(window.location.search))}" title="Open generator demo">generator</a>`
    : lockGen
      ? ''
      : `<button type="button" id="lv-mode-toggle" class="live__btn live__btn--mode" title="Switch mode (G)" aria-pressed="false" disabled>generator</button>`;

  root.innerHTML = `
    <div class="live" id="lv-root" data-state="boot" data-chrome="${opts.chrome}" data-kind="${opts.kind}" data-hud="${opts.startHudVisible ? 'on' : 'off'}" data-loading="true">
      <div class="live__stage" id="lv-viewport"></div>
      <div class="live__vignette" aria-hidden="true"></div>

      <div class="live__boot" id="lv-boot" role="status" aria-live="polite" aria-busy="true">
        <div class="live__boot-card">
          <div class="live__boot-brand">
            <span class="live__dot" aria-hidden="true"></span>
            <span class="live__boot-title">${escapeHtml(opts.policyName)}</span>
          </div>
          <p class="live__boot-label" id="lv-boot-label">Loading…</p>
          <div class="live__boot-bar" aria-hidden="true">
            <span class="live__boot-fill" id="lv-boot-fill"></span>
          </div>
          <p class="live__boot-pct" id="lv-boot-pct">0%</p>
        </div>
      </div>

      <header class="live__topbar">
        <a class="live__back" href="${galleryHref()}" title="All clips" aria-label="All clips">←</a>
        <a class="live__back live__github" href="${escapeHtml(opts.repoUrl)}" target="_blank" rel="noopener noreferrer" title="View on GitHub" aria-label="View on GitHub">${GITHUB_ICON}</a>
        ${themeToggleHtml('lv-theme')}
        <div class="live__brand">
          <span class="live__dot" aria-hidden="true"></span>
          <span class="live__wordmark">${escapeHtml(opts.policyName)}</span>
          <span class="live__state" id="lv-state">boot</span>
          ${tracking ? '<span class="live__mode-pill">tracking</span>' : ''}
        </div>
        <div class="live__status" id="lv-status">booting…</div>
        <div class="live__controls">
          <label class="live__select live__select--clip"><span>trajectory</span><select id="lv-clip"></select></label>
          <button type="button" id="lv-prev" class="live__btn live__btn--dense" title="Previous clip (←)">◀</button>
          <button type="button" id="lv-next" class="live__btn live__btn--dense" title="Next clip (→)">▶</button>
          <button type="button" id="lv-getup" class="live__btn live__btn--dense" title="Get up from floor (↑)">get up</button>
          <button type="button" id="lv-liedown" class="live__btn live__btn--dense" title="Lie down when idle (↓)">lie down</button>
          <label class="live__select live__select--dense"><span>speed</span>
            <select id="lv-speed">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <button type="button" id="lv-mode" class="live__btn live__btn--dense" title="Toggle policy on/off (P)">policy</button>
          <button type="button" id="lv-push" class="live__btn live__btn--dense" title="Shove the robot">push</button>
          <button type="button" id="lv-follow" class="live__btn live__btn--dense" title="Follow robot (F)" aria-pressed="true">follow</button>
          <button type="button" id="lv-chase" class="live__btn live__btn--dense" title="Chase cam (V)" aria-pressed="false">chase</button>
          <button type="button" id="lv-loop" class="live__btn live__btn--dense" title="Loop clip" aria-pressed="false">loop</button>
          <button type="button" id="lv-play" class="live__btn live__btn--primary" title="Play / pause (Space)">⏸&nbsp;pause</button>
          <button type="button" id="lv-reset" class="live__btn" title="Reset sim pose (R)">↺&nbsp;reset</button>
          <details class="live__more" id="lv-more">
            <summary class="live__more-toggle" title="More controls">more</summary>
            <div class="live__more-body" id="lv-more-body"></div>
          </details>
          <button type="button" id="lv-chrome" class="live__btn live__btn--chrome" title="Toggle compact UI">compact</button>
          ${tracking ? '' : '<button type="button" id="lv-pad-toggle" class="live__btn live__btn--pad" title="Toggle on-screen stick / run / crouch">pad</button>'}
          ${modeControl}
          <details class="live__keys" id="lv-keys">
            <summary class="live__keys-toggle" id="lv-keys-summary" title="Controls help (?)">controls</summary>
            <div class="live__keys-body">
              <section class="live__keys-pane" id="lv-keys-general" aria-labelledby="lv-keys-general-title">
                <h3 class="live__keys-heading" id="lv-keys-general-title">General</h3>
                <table class="live__keys-table">
                  <tbody>
                    <tr data-keys-mode="clips"><th scope="row"><kbd>Space</kbd></th><td>Play / pause clip</td></tr>
                    <tr data-keys-mode="gen"><th scope="row"><kbd>Space</kbd></th><td>Crouch style</td></tr>
                    <tr><th scope="row"><kbd>R</kbd></th><td>Reset sim pose</td></tr>
                    <tr><th scope="row"><kbd>F</kbd></th><td>Toggle camera follow</td></tr>
                    <tr><th scope="row"><kbd>V</kbd></th><td>Toggle chase cam</td></tr>
                    <tr><th scope="row"><kbd>P</kbd></th><td>Policy on / off</td></tr>
                    ${lockGen ? '' : '<tr data-keys-mode="live"><th scope="row"><kbd>G</kbd></th><td>Toggle generator ↔ tracking</td></tr>'}
                    <tr><th scope="row"><kbd>H</kbd></th><td>Hide / show HUD</td></tr>
                    <tr><th scope="row"><kbd>?</kbd></th><td>Show / hide this menu</td></tr>
                    <tr><th scope="row">Drag</th><td>Perturb robot</td></tr>
                  </tbody>
                </table>
              </section>

              <section class="live__keys-pane live__keys-pane--clips" id="lv-keys-clips" aria-labelledby="lv-keys-clips-title">
                <h3 class="live__keys-heading" id="lv-keys-clips-title">Tracking</h3>
                <p class="live__keys-note">Policy tracks the selected reference trajectory.</p>
                <table class="live__keys-table">
                  <tbody>
                    <tr><th scope="row"><kbd>←</kbd> <kbd>→</kbd></th><td>Previous / next clip</td></tr>
                    <tr><th scope="row"><kbd>↑</kbd></th><td>Get up (when down)</td></tr>
                    <tr><th scope="row"><kbd>↓</kbd></th><td>Lie down (when idle)</td></tr>
                    <tr><th scope="row">Loop</th><td>Repeat clip when finished</td></tr>
                    <tr><th scope="row">Trajectory</th><td>Pick a clip from the dropdown</td></tr>
                  </tbody>
                </table>
              </section>

              ${tracking ? '' : `
              <section class="live__keys-pane live__keys-pane--gen" id="lv-keys-gen" aria-labelledby="lv-keys-gen-title" hidden>
                <h3 class="live__keys-heading" id="lv-keys-gen-title">
                  Generator
                  <span class="live__keys-badge" id="lv-keys-gen-badge">off</span>
                </h3>
                <p class="live__keys-note">Locomotion from the generator. Use keys or the on-screen <strong>pad</strong> on touch.</p>
                <table class="live__keys-table">
                  <tbody>
                    <tr><th scope="row"><kbd>W</kbd> <kbd>S</kbd></th><td>Forward / back</td></tr>
                    <tr><th scope="row"><kbd>Q</kbd> <kbd>E</kbd></th><td>Strafe left / right</td></tr>
                    <tr><th scope="row"><kbd>A</kbd> <kbd>D</kbd></th><td>Yaw left / right</td></tr>
                    <tr><th scope="row"><kbd>Shift</kbd></th><td>Run style</td></tr>
                    <tr><th scope="row"><kbd>Space</kbd></th><td>Crouch style</td></tr>
                    <tr><th scope="row"><kbd>↓</kbd></th><td>Sit</td></tr>
                    <tr><th scope="row"><kbd>↑</kbd></th><td>Return to walk / run / crouch</td></tr>
                    <tr><th scope="row">Pad</th><td>Analog stick (drag) · run · crouch</td></tr>
                  </tbody>
                </table>
              </section>`}
            </div>
          </details>
        </div>
      </header>

      <div class="live__pad" id="lv-pad" hidden aria-hidden="true">
        <div class="live__stick" id="lv-stick" aria-label="Move">
          <div class="live__stick-base">
            <div class="live__stick-knob" id="lv-stick-knob"></div>
          </div>
        </div>
        <div class="live__pad-actions">
          <button type="button" class="live__pad-btn" id="lv-yaw-l" aria-label="Turn left">⟲</button>
          <button type="button" class="live__pad-btn" id="lv-yaw-r" aria-label="Turn right">⟳</button>
          <button type="button" class="live__pad-btn live__pad-btn--sprint" id="lv-sprint">run</button>
          <button type="button" class="live__pad-btn live__pad-btn--crouch" id="lv-crouch">crouch</button>
        </div>
      </div>

      ${tracking || lockGen ? '' : `
      <div class="live__hud-mini" id="lv-hud-mini">
        <button type="button" id="lv-mode-mini" class="live__mode-mini live__btn live__btn--mode" title="Switch mode (G)" aria-pressed="false" disabled>generator</button>
        <div class="live__minibar" id="lv-minibar" aria-label="Compact clip controls">
          <label class="live__select live__select--clip live__minibar-clip">
            <span class="live__minibar-label">trajectory</span>
            <select id="lv-clip-mini"></select>
          </label>
          <button type="button" id="lv-mini-play" class="live__btn live__btn--icon" title="Play">▶</button>
          <button type="button" id="lv-mini-pause" class="live__btn live__btn--icon" title="Pause">⏸</button>
          <button type="button" id="lv-mini-loop" class="live__btn live__btn--icon" title="Loop" aria-pressed="false">↻</button>
        </div>
      </div>`}
      ${tracking ? `
      <div class="live__minibar" id="lv-minibar" aria-label="Compact clip controls">
        <label class="live__select live__select--clip live__minibar-clip">
          <span class="live__minibar-label">trajectory</span>
          <select id="lv-clip-mini"></select>
        </label>
        <button type="button" id="lv-mini-play" class="live__btn live__btn--icon" title="Play">▶</button>
        <button type="button" id="lv-mini-pause" class="live__btn live__btn--icon" title="Pause">⏸</button>
        <button type="button" id="lv-mini-loop" class="live__btn live__btn--icon" title="Loop" aria-pressed="false">↻</button>
      </div>` : ''}

      <footer class="live__telemetry" id="lv-metrics"></footer>
      <div class="live__progress" aria-hidden="true"><span id="lv-progress"></span></div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const rootEl = $('#lv-root');
  const viewport = $<HTMLElement>('#lv-viewport');
  const bootEl = $<HTMLElement>('#lv-boot');
  const bootLabelEl = $<HTMLElement>('#lv-boot-label');
  const bootFillEl = $<HTMLElement>('#lv-boot-fill');
  const bootPctEl = $<HTMLElement>('#lv-boot-pct');
  const statusEl = $('#lv-status');
  const stateEl = $('#lv-state');
  const metricsEl = $('#lv-metrics');
  const progressEl = $('#lv-progress');
  const clipEl = $<HTMLSelectElement>('#lv-clip');
  const clipMiniEl = $<HTMLSelectElement>('#lv-clip-mini');
  const miniBarEl = $<HTMLElement>('#lv-minibar');
  const miniPlayEl = $<HTMLButtonElement>('#lv-mini-play');
  const miniPauseEl = $<HTMLButtonElement>('#lv-mini-pause');
  const miniLoopEl = $<HTMLButtonElement>('#lv-mini-loop');
  const prevEl = $<HTMLButtonElement>('#lv-prev');
  const nextEl = $<HTMLButtonElement>('#lv-next');
  const getupEl = $<HTMLButtonElement>('#lv-getup');
  const liedownEl = $<HTMLButtonElement>('#lv-liedown');
  const genEl = tracking || lockGen ? null : $<HTMLButtonElement>('#lv-mode-toggle');
  const genMiniEl = tracking || lockGen ? null : $<HTMLButtonElement>('#lv-mode-mini');
  const speedEl = $<HTMLSelectElement>('#lv-speed');
  const modeEl = $<HTMLButtonElement>('#lv-mode');
  const pushEl = $<HTMLButtonElement>('#lv-push');
  const followEl = $<HTMLButtonElement>('#lv-follow');
  const chaseEl = $<HTMLButtonElement>('#lv-chase');
  const loopEl = $<HTMLButtonElement>('#lv-loop');
  const playEl = $<HTMLButtonElement>('#lv-play');
  const resetEl = $<HTMLButtonElement>('#lv-reset');
  const chromeEl = $<HTMLButtonElement>('#lv-chrome');
  const padToggleEl = tracking ? null : $<HTMLButtonElement>('#lv-pad-toggle');
  const moreEl = $<HTMLDetailsElement>('#lv-more');
  const moreBody = $<HTMLElement>('#lv-more-body');
  const keysEl = $<HTMLDetailsElement>('#lv-keys');
  const keysSummaryEl = $<HTMLElement>('#lv-keys-summary');
  const clipsPaneEl = $<HTMLElement>('#lv-keys-clips');
  const genPaneEl = tracking ? null : $<HTMLElement>('#lv-keys-gen');
  const genBadgeEl = tracking ? null : $<HTMLElement>('#lv-keys-gen-badge');
  const padEl = $<HTMLElement>('#lv-pad');
  const stickEl = $<HTMLElement>('#lv-stick');
  const stickKnob = $<HTMLElement>('#lv-stick-knob');
  const sprintEl = $<HTMLButtonElement>('#lv-sprint');
  const crouchEl = $<HTMLButtonElement>('#lv-crouch');
  const yawLEl = $<HTMLButtonElement>('#lv-yaw-l');
  const yawREl = $<HTMLButtonElement>('#lv-yaw-r');
  wireThemeToggle($<HTMLButtonElement>('#lv-theme'));
  window.addEventListener(THEME_EVENT, () => {
    engine?.viewer.applyThemeColors();
  });

  // Compact "more" menu hosts dense controls when chrome is minimal.
  const controlsHost = playEl.parentElement!;
  const denseControls = [
    prevEl, nextEl, getupEl, liedownEl, speedEl.parentElement!,
    modeEl, pushEl, followEl, chaseEl, loopEl,
  ];
  function placeDenseControls(next: 'full' | 'minimal'): void {
    if (next === 'minimal') {
      for (const el of denseControls) moreBody.appendChild(el);
    } else {
      for (const el of denseControls) controlsHost.insertBefore(el, playEl);
    }
    moreEl.hidden = next !== 'minimal';
    if (next !== 'minimal') moreEl.open = false;
  }
  placeDenseControls(opts.chrome);

  let bootProgress = 0;
  let bootDone = false;

  function setBootProgress(pct: number, label?: string): void {
    if (bootDone) return;
    bootProgress = Math.max(bootProgress, Math.min(100, Math.round(pct)));
    bootFillEl.style.width = `${bootProgress}%`;
    bootPctEl.textContent = `${bootProgress}%`;
    if (label) bootLabelEl.textContent = label;
  }

  function noteBootMessage(msg: string): void {
    if (bootDone) return;
    const mesh = /^Fetching meshes (\d+)\/(\d+)/i.exec(msg);
    if (mesh) {
      const n = Number(mesh[1]);
      const total = Math.max(1, Number(mesh[2]));
      setBootProgress(28 + (n / total) * 42, msg);
      return;
    }
    const steps: Array<{ re: RegExp; pct: number }> = [
      { re: /Loading config/i, pct: 8 },
      { re: /No reference\/manifest/i, pct: 12 },
      { re: /Loading MuJoCo|Loading.*policy/i, pct: 22 },
      { re: /Loading generator/i, pct: 78 },
      { re: /Generator ready|Generator unavailable/i, pct: 92 },
      { re: /Loading clip/i, pct: 96 },
      { re: /Tracking/i, pct: 98 },
    ];
    for (const step of steps) {
      if (step.re.test(msg)) {
        setBootProgress(step.pct, msg);
        return;
      }
    }
    setBootProgress(bootProgress, msg);
  }

  function finishBoot(err = false): void {
    if (bootDone) return;
    bootDone = true;
    if (err) {
      rootEl.dataset.loading = 'error';
      bootEl.setAttribute('aria-busy', 'false');
      return;
    }
    setBootProgress(100, 'Ready');
    rootEl.dataset.loading = 'done';
    bootEl.setAttribute('aria-busy', 'false');
    window.setTimeout(() => {
      bootEl.hidden = true;
    }, 420);
  }

  setBootProgress(3, 'Starting…');

  let latest: LiveStatus | undefined;
  let playing = true;
  let mode: EngineMode = 'policy';
  let refSource: RefSource = tracking ? 'clips' : 'clips';
  let chrome: 'full' | 'minimal' = opts.chrome;
  let padEnabled = opts.padEnabled;
  let notifyTeleop: (() => void) | undefined;

  const pad = {
    forward: 0,
    strafe: 0,
    yaw: 0,
    sprint: false,
    crouch: false,
  };

  function setChrome(next: 'full' | 'minimal'): void {
    chrome = next;
    rootEl.dataset.chrome = next;
    chromeEl.textContent = next === 'minimal' ? 'full UI' : 'compact';
    chromeEl.setAttribute('aria-pressed', String(next === 'minimal'));
    placeDenseControls(next);
    opts.onChromeChange(next);
    syncPadVisibility();
  }

  function setPadEnabled(on: boolean): void {
    padEnabled = on;
    savePadPref(on);
    if (padToggleEl) {
      padToggleEl.setAttribute('aria-pressed', String(on));
      padToggleEl.textContent = on ? 'pad on' : 'pad';
      padToggleEl.title = on
        ? 'Hide on-screen stick / run / crouch'
        : 'Show on-screen stick / run / crouch';
    }
    syncPadVisibility();
  }

  function syncPadVisibility(): void {
    const show = !tracking && padEnabled && refSource === 'gen';
    const wasShown = !padEl.hidden;
    padEl.hidden = !show;
    padEl.setAttribute('aria-hidden', String(!show));
    rootEl.dataset.pad = show ? 'on' : 'off';
    if (padToggleEl) {
      // Toggle stays available once Gen assets exist; stick only draws while Gen is active.
      padToggleEl.disabled = latest != null && latest.genAvailable === false;
    }
    if (!show && wasShown) {
      pad.forward = 0;
      pad.strafe = 0;
      pad.yaw = 0;
      pad.sprint = false;
      pad.crouch = false;
      stickKnob.style.transform = '';
    }
    notifyTeleop?.();
  }

  function renderState(): void {
    let state = 'live', label = 'live';
    if (latest?.error) { state = 'fell'; label = 'error'; }
    else if (refSource === 'gen' && latest?.ready) { state = 'live'; label = 'gen'; }
    else if (mode === 'open-loop' && latest?.ready) { state = 'paused'; label = 'open-loop'; }
    else if (latest?.fell) { state = 'fell'; label = 'fell'; }
    else if (!latest?.ready) { state = 'boot'; label = 'boot'; }
    else if (!playing) { state = 'paused'; label = 'paused'; }
    else if (tracking) { state = 'live'; label = 'track'; }
    rootEl.dataset.state = state;
    stateEl.textContent = label;
  }

  function syncKeysHelp(): void {
    const genOn = !tracking && refSource === 'gen';
    rootEl.dataset.ref = genOn ? 'gen' : 'clips';
    keysSummaryEl.textContent = 'controls';
    clipsPaneEl.hidden = genOn;
    if (genPaneEl) {
      genPaneEl.hidden = !genOn;
      genPaneEl.dataset.active = genOn ? 'true' : 'false';
    }
    for (const row of rootEl.querySelectorAll<HTMLElement>('[data-keys-mode]')) {
      const m = row.dataset.keysMode;
      if (m === 'gen') row.hidden = !genOn;
      else if (m === 'clips') row.hidden = genOn;
      else if (m === 'live') row.hidden = tracking;
    }
  }

  function syncGenButton(): void {
    if (!genEl) {
      syncKeysHelp();
      syncPadVisibility();
      syncMiniTransport();
      return;
    }
    // Prefer live status; before the first onStatus tick use a soft enable so
    // the toggle isn't stuck disabled while Gen is still booting.
    const avail = latest == null ? true : latest.genAvailable === true;
    const down = latest != null && !latest.robotIsUp;
    const disabled = !avail || (down && refSource !== 'gen');
    const genOn = refSource === 'gen';
    const label = genOn ? 'tracking' : 'generator';
    const title = genOn
      ? 'Switch to tracking / clips (G)'
      : 'Switch to generator locomotion (G)';
    for (const btn of [genEl, genMiniEl]) {
      if (!btn) continue;
      btn.disabled = disabled;
      btn.setAttribute('aria-pressed', String(genOn));
      btn.classList.toggle('live__btn--warn', genOn);
      btn.textContent = label;
      btn.title = title;
    }

    if (genBadgeEl) {
      genBadgeEl.textContent = !avail ? 'n/a' : genOn ? 'on' : 'off';
      genBadgeEl.dataset.tone = !avail ? 'muted' : genOn ? 'on' : 'off';
    }
    syncKeysHelp();
    syncPadVisibility();
    syncMiniTransport();
  }

  function syncMiniTransport(): void {
    const genOn = refSource === 'gen';
    rootEl.dataset.ref = genOn ? 'gen' : 'clips';
    const showMini = !genOn;
    miniBarEl.hidden = !showMini;
    miniBarEl.setAttribute('aria-hidden', String(!showMini));
    miniPlayEl.disabled = playing;
    miniPauseEl.disabled = !playing;
    miniPlayEl.setAttribute('aria-pressed', String(playing));
    miniPauseEl.setAttribute('aria-pressed', String(!playing));
    miniLoopEl.setAttribute('aria-pressed', loopEl.getAttribute('aria-pressed') ?? 'false');
    clipMiniEl.disabled = clipEl.disabled;
  }

  function fillClipSelects(clips: ReferenceClip[], current?: string | null): void {
    const html = clips
      .map((c) => `<option value="${c.id}"${c.id === current ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    clipEl.innerHTML = html;
    clipMiniEl.innerHTML = html;
  }

  let hudVisible = opts.startHudVisible;
  function setHudVisible(on: boolean): void {
    hudVisible = on;
    rootEl.dataset.hud = on ? 'on' : 'off';
    if (!on) {
      keysEl.open = false;
      moreEl.open = false;
    }
  }
  if (!opts.startHudVisible) setHudVisible(false);

  chromeEl.textContent = chrome === 'minimal' ? 'full UI' : 'compact';
  chromeEl.setAttribute('aria-pressed', String(chrome === 'minimal'));
  chromeEl.addEventListener('click', () => {
    setChrome(chrome === 'minimal' ? 'full' : 'minimal');
  });
  if (padToggleEl) {
    setPadEnabled(padEnabled);
    padToggleEl.addEventListener('click', () => setPadEnabled(!padEnabled));
  }
  // One topbar dropdown open at a time.
  keysEl.addEventListener('toggle', () => {
    if (keysEl.open) moreEl.open = false;
  });
  moreEl.addEventListener('toggle', () => {
    if (moreEl.open) keysEl.open = false;
  });
  syncKeysHelp();

  return {
    viewport,
    setStatus(s: string, err = false) {
      statusEl.textContent = s;
      statusEl.style.color = err ? 'var(--color-danger)' : '';
      if (err) {
        rootEl.dataset.state = 'fell';
        stateEl.textContent = 'error';
        bootLabelEl.textContent = s;
        bootLabelEl.dataset.tone = 'error';
        finishBoot(true);
        return;
      }
      noteBootMessage(s);
    },
    populateClips(clips: ReferenceClip[]) {
      fillClipSelects(clips, latest?.clipId);
    },
    updateFsm(s: LiveStatus) {
      refSource = s.refSource;
      clipEl.disabled = !s.canBrowse;
      clipMiniEl.disabled = !s.canBrowse;
      prevEl.disabled = !s.canBrowse;
      nextEl.disabled = !s.canBrowse;
      getupEl.disabled = !s.canGetup;
      liedownEl.disabled = !s.canLiedown;
      syncGenButton();
      syncMiniTransport();
    },
    updateMetrics(s: LiveStatus) {
      latest = s;
      playing = s.playing;
      refSource = s.refSource;
      playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
      playEl.hidden = s.refSource === 'gen';
      loopEl.setAttribute('aria-pressed', String(s.loop));
      renderState();
      this.updateFsm(s);
      syncMiniTransport();
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
      if (clipMiniEl.value !== s.clipId && s.clipId) clipMiniEl.value = s.clipId;
    },
    wire(h: LiveEngineHandle) {
      let following = true;
      let chasing = false;
      latest = h.status;
      refSource = h.status.refSource;
      finishBoot(false);

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

      const heldKeys = new Set<string>();

      const syncPadHighlights = (input: {
        yaw: number;
        sprint: boolean;
        crouch: boolean;
      }): void => {
        sprintEl.setAttribute('aria-pressed', String(input.sprint));
        crouchEl.setAttribute('aria-pressed', String(input.crouch));
        yawLEl.setAttribute('aria-pressed', String(input.yaw > 0.05));
        yawREl.setAttribute('aria-pressed', String(input.yaw < -0.05));
      };

      const syncTeleop = (): void => {
        if (refSource !== 'gen') {
          h.setGenTeleop({
            forward: 0, strafe: 0, yaw: 0, sprint: false, crouch: false,
          });
          syncPadHighlights({ yaw: 0, sprint: false, crouch: false });
          return;
        }
        const keyForward = (heldKeys.has('KeyW') ? 1 : 0) + (heldKeys.has('KeyS') ? -1 : 0);
        const keyStrafe = (heldKeys.has('KeyQ') ? 1 : 0) + (heldKeys.has('KeyE') ? -1 : 0);
        const keyYaw = (heldKeys.has('KeyA') ? 1 : 0) + (heldKeys.has('KeyD') ? -1 : 0);
        const keySprint = heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight');
        const keyCrouch = heldKeys.has('Space');
        const yaw = clampAxis(keyYaw + pad.yaw);
        const sprint = keySprint || pad.sprint;
        const crouch = keyCrouch || pad.crouch;
        h.setGenTeleop({
          forward: clampAxis(keyForward + pad.forward),
          strafe: clampAxis(keyStrafe + pad.strafe),
          yaw,
          sprint,
          crouch,
        });
        syncPadHighlights({ yaw, sprint, crouch });
      };
      notifyTeleop = syncTeleop;

      const selectClip = (id: string): void => {
        void h.selectClip(id);
      };
      clipEl.addEventListener('change', () => selectClip(clipEl.value));
      clipMiniEl.addEventListener('change', () => selectClip(clipMiniEl.value));
      prevEl.addEventListener('click', () => void h.browsePrevClip());
      nextEl.addEventListener('click', () => void h.browseNextClip());
      getupEl.addEventListener('click', () => void h.triggerGetup());
      liedownEl.addEventListener('click', () => void h.triggerLiedown());
      const onToggleGen = (): void => {
        void h.toggleGen().then((on) => {
          refSource = on ? 'gen' : 'clips';
          heldKeys.clear();
          syncTeleop();
          syncGenButton();
          renderState();
        });
      };
      genEl?.addEventListener('click', onToggleGen);
      genMiniEl?.addEventListener('click', onToggleGen);
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
      const setLoopUi = (on: boolean): void => {
        h.setLoop(on);
        loopEl.setAttribute('aria-pressed', String(on));
        miniLoopEl.setAttribute('aria-pressed', String(on));
      };
      loopEl.addEventListener('click', () => {
        setLoopUi(loopEl.getAttribute('aria-pressed') !== 'true');
      });
      resetEl.addEventListener('click', () => h.reset());
      const syncPlayUi = (): void => {
        playEl.innerHTML = playing ? '⏸&nbsp;pause' : '▶&nbsp;play';
        syncMiniTransport();
        renderState();
      };
      playEl.addEventListener('click', () => {
        if (refSource === 'gen') return;
        playing = h.toggle();
        syncPlayUi();
      });
      miniPlayEl.addEventListener('click', () => {
        if (refSource === 'gen') return;
        if (!playing) {
          h.play();
          playing = true;
          syncPlayUi();
        }
      });
      miniPauseEl.addEventListener('click', () => {
        if (refSource === 'gen') return;
        if (playing) {
          h.pause();
          playing = false;
          syncPlayUi();
        }
      });
      miniLoopEl.addEventListener('click', () => {
        if (refSource === 'gen') return;
        setLoopUi(miniLoopEl.getAttribute('aria-pressed') !== 'true');
      });

      syncFollowButton();
      syncChaseButton();
      syncGenButton();
      syncMiniTransport();
      renderState();
      syncPadVisibility();

      padCleanup?.();
      padCleanup = wireVirtualPad({
        stickEl,
        stickKnob,
        sprintEl,
        crouchEl,
        yawLEl,
        yawREl,
        pad,
        onChange: syncTeleop,
      });

      const onKeyDown = (e: KeyboardEvent): void => {
        const el = e.target;
        if (!(el instanceof HTMLElement)) return;
        if (el.isContentEditable) return;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        const teleopCodes = [
          'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
          'ShiftLeft', 'ShiftRight', 'Space',
        ];
        if (teleopCodes.includes(e.code) && (e.code !== 'Space' || refSource === 'gen')) {
          heldKeys.add(e.code);
          syncTeleop();
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
            if (refSource === 'gen') break;
            playing = h.toggle();
            syncPlayUi();
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
            if (refSource === 'gen' && !tracking) {
              h.nudgeGenPosture(-1);
            } else if (!getupEl.disabled) {
              void h.triggerGetup();
            }
            break;
          case 'ArrowDown':
            e.preventDefault();
            if (refSource === 'gen' && !tracking) {
              h.nudgeGenPosture(+1);
            } else if (!liedownEl.disabled) {
              void h.triggerLiedown();
            }
            break;
          case 'KeyG':
            if (tracking || !genEl) break;
            e.preventDefault();
            void h.toggleGen().then((on) => {
              refSource = on ? 'gen' : 'clips';
              heldKeys.clear();
              syncTeleop();
              syncGenButton();
              syncMiniTransport();
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
          case 'KeyH':
            e.preventDefault();
            setHudVisible(!hudVisible);
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
        if (heldKeys.delete(e.code)) syncTeleop();
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

function clampAxis(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

interface PadState {
  forward: number;
  strafe: number;
  yaw: number;
  sprint: boolean;
  crouch: boolean;
}

function wireVirtualPad(opts: {
  stickEl: HTMLElement;
  stickKnob: HTMLElement;
  sprintEl: HTMLButtonElement;
  crouchEl: HTMLButtonElement;
  yawLEl: HTMLButtonElement;
  yawREl: HTMLButtonElement;
  pad: PadState;
  onChange: () => void;
}): () => void {
  const { stickEl, stickKnob, sprintEl, crouchEl, yawLEl, yawREl, pad, onChange } = opts;
  let activePointer: number | null = null;
  /** Grab origin — drag distance from here sets analog magnitude (not absolute base position). */
  let originX = 0;
  let originY = 0;
  let maxRadius = 48;

  const applyStick = (clientX: number, clientY: number): void => {
    const dx = clientX - originX;
    const dy = clientY - originY;
    const len = Math.hypot(dx, dy);
    const mag = maxRadius > 0 ? Math.min(1, len / maxRadius) : 0;
    let nx = 0;
    let ny = 0;
    if (len > 1e-6) {
      nx = dx / len;
      ny = dy / len;
    }
    stickKnob.style.transform = `translate(${nx * mag * maxRadius}px, ${ny * mag * maxRadius}px)`;
    // Unit-circle axes: magnitude ∝ drag distance from grab, direction = drag angle.
    // Screen Y down → negative forward; X right → negative strafe (Q = +strafe left).
    pad.forward = clampAxis(-ny * mag);
    pad.strafe = clampAxis(-nx * mag);
    onChange();
  };

  const resetStick = (): void => {
    activePointer = null;
    pad.forward = 0;
    pad.strafe = 0;
    stickKnob.style.transform = '';
    onChange();
  };

  const onStickDown = (e: PointerEvent): void => {
    e.preventDefault();
    activePointer = e.pointerId;
    const base = stickEl.querySelector('.live__stick-base') as HTMLElement;
    const rect = base.getBoundingClientRect();
    // Travel ≈ base radius minus knob half-size so full deflection is reachable.
    maxRadius = Math.max(28, rect.width * 0.42);
    originX = e.clientX;
    originY = e.clientY;
    stickEl.setPointerCapture(e.pointerId);
    applyStick(e.clientX, e.clientY);
  };
  const onStickMove = (e: PointerEvent): void => {
    if (activePointer !== e.pointerId) return;
    e.preventDefault();
    applyStick(e.clientX, e.clientY);
  };
  const onStickUp = (e: PointerEvent): void => {
    if (activePointer !== e.pointerId) return;
    resetStick();
  };

  stickEl.addEventListener('pointerdown', onStickDown);
  stickEl.addEventListener('pointermove', onStickMove);
  stickEl.addEventListener('pointerup', onStickUp);
  stickEl.addEventListener('pointercancel', onStickUp);

  const holdBtn = (
    btn: HTMLButtonElement,
    apply: (down: boolean) => void,
  ): (() => void) => {
    let held = false;
    const set = (down: boolean): void => {
      if (held === down) return;
      held = down;
      apply(down);
      onChange();
    };
    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      set(true);
    };
    const onUp = (): void => set(false);
    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
    btn.addEventListener('lostpointercapture', onUp);
    return () => {
      btn.removeEventListener('pointerdown', onDown);
      btn.removeEventListener('pointerup', onUp);
      btn.removeEventListener('pointercancel', onUp);
      btn.removeEventListener('lostpointercapture', onUp);
      set(false);
    };
  };

  let yawL = false;
  let yawR = false;
  const syncYaw = (): void => {
    pad.yaw = (yawL ? 1 : 0) + (yawR ? -1 : 0);
  };

  const cleanups = [
    holdBtn(sprintEl, (d) => { pad.sprint = d; }),
    holdBtn(crouchEl, (d) => { pad.crouch = d; }),
    holdBtn(yawLEl, (d) => { yawL = d; syncYaw(); }),
    holdBtn(yawREl, (d) => { yawR = d; syncYaw(); }),
  ];

  return () => {
    stickEl.removeEventListener('pointerdown', onStickDown);
    stickEl.removeEventListener('pointermove', onStickMove);
    stickEl.removeEventListener('pointerup', onStickUp);
    stickEl.removeEventListener('pointercancel', onStickUp);
    for (const c of cleanups) c();
    resetStick();
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
  padCleanup?.();
  engine?.dispose();
});
