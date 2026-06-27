/**
 * Wbc_Tracking clip FSM — mirrors wbc-g1-deploy State_WbcTracking::handleClipSwitch.
 *
 * Top-level deploy states (Passive / FixStand / FloorReady) are UI entry paths;
 * this module covers in-tracking behavior: browse vs play, getup when down,
 * liedown when up and idle. Clip switches only swap the reference stream and
 * reset policy actions — never teleport the sim (deploy: applyMotionLoader).
 */

export type ClipKind = 'browsable' | 'pose_getup' | 'pose_liedown';

export interface WbcFsmState {
  robotIsUp: boolean;
  awaitingClipSelect: boolean;
  clipPlaybackActive: boolean;
  playbackFinished: boolean;
  selectedBrowsableIndex: number;
  currentKind: ClipKind;
}

export function createWbcFsm(
  selectedIndex = 0,
  opts?: { fromFloor?: boolean },
): WbcFsmState {
  if (opts?.fromFloor) {
    return {
      robotIsUp: false,
      awaitingClipSelect: false,
      clipPlaybackActive: true,
      playbackFinished: false,
      selectedBrowsableIndex: selectedIndex,
      currentKind: 'pose_getup',
    };
  }
  return {
    robotIsUp: true,
    awaitingClipSelect: true,
    clipPlaybackActive: false,
    playbackFinished: false,
    selectedBrowsableIndex: selectedIndex,
    currentKind: 'browsable',
  };
}

export function enterClipSelectMode(s: WbcFsmState): void {
  s.awaitingClipSelect = true;
  s.clipPlaybackActive = false;
  s.playbackFinished = false;
}

export function canGetup(s: WbcFsmState): boolean {
  return !s.robotIsUp && !s.clipPlaybackActive;
}

export function canLiedown(s: WbcFsmState): boolean {
  return s.robotIsUp && (s.awaitingClipSelect || s.playbackFinished);
}

export function canBrowseClips(s: WbcFsmState): boolean {
  return s.robotIsUp && s.awaitingClipSelect;
}

export function canPlaySelectedClip(s: WbcFsmState): boolean {
  return canBrowseClips(s);
}

/** Rising edge: clip reached end (deploy: playback finished). */
export function onClipFinished(s: WbcFsmState): void {
  s.clipPlaybackActive = false;
  s.playbackFinished = true;
  if (s.currentKind === 'pose_getup') {
    s.robotIsUp = true;
    enterClipSelectMode(s);
    return;
  }
  if (s.currentKind === 'pose_liedown') {
    s.robotIsUp = false;
    s.awaitingClipSelect = false;
    return;
  }
  enterClipSelectMode(s);
}

export function startPosePlayback(s: WbcFsmState, kind: 'pose_getup' | 'pose_liedown'): void {
  s.currentKind = kind;
  s.awaitingClipSelect = false;
  s.clipPlaybackActive = true;
  s.playbackFinished = false;
}

export function startBrowsablePlayback(s: WbcFsmState): void {
  s.currentKind = 'browsable';
  s.awaitingClipSelect = false;
  s.clipPlaybackActive = true;
  s.playbackFinished = false;
}

export function browseNext(s: WbcFsmState, count: number): void {
  if (!canBrowseClips(s) || count <= 0) return;
  s.selectedBrowsableIndex = (s.selectedBrowsableIndex + 1) % count;
}

export function browsePrev(s: WbcFsmState, count: number): void {
  if (!canBrowseClips(s) || count <= 0) return;
  s.selectedBrowsableIndex = (s.selectedBrowsableIndex - 1 + count) % count;
}

export function fsmUiLabel(s: WbcFsmState): string {
  if (!s.robotIsUp) return s.clipPlaybackActive ? 'getup' : 'down';
  if (s.awaitingClipSelect) return 'select';
  if (s.clipPlaybackActive) return 'playing';
  return 'idle';
}
