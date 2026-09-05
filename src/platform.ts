/** Safari / iPhone / iframe helpers. The live page is often embedded. */

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports as MacIntel but has touch.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** Cheaper GL on iPhone — 4 GB class + Safari GPU budget. */
export function preferLowQualityGl(): boolean {
  return isIos();
}

export function wasmSimdSupported(): boolean {
  try {
    // iOS < 16.4 has WASM but not SIMD; ORT 1.20 only ships a SIMD build.
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
      8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

/** WebGL on iOS dies if the canvas is created at 0×0 (common in iframes). */
export function whenElementSized(el: HTMLElement, timeoutMs = 2500): Promise<void> {
  if (el.clientWidth > 1 && el.clientHeight > 1) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      ro.disconnect();
      resolve();
    };
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 1 && el.clientHeight > 1) finish();
    });
    ro.observe(el);
    requestAnimationFrame(() => {
      if (el.clientWidth > 1 && el.clientHeight > 1) finish();
    });
    setTimeout(finish, timeoutMs);
  });
}
