/**
 * Array.prototype.at (ES2022) is used by @remix-run/route-pattern during
 * Router init (parsePart → appendText → tokens.at(-1)). Vite's build target
 * is chrome107+, which includes `.at`, but some Chromium WebViews / older
 * shells still report as Chrome without the method — that threw
 * "TypeError: i.at is not a function" (KODY-VIDEO-M) before any route rendered.
 *
 * Spec-shaped polyfill; no-op when the native method exists.
 * @see https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.at
 */
export function installArrayAtPolyfill(): void {
  if (typeof Array.prototype.at === 'function') return

  Object.defineProperty(Array.prototype, 'at', {
    value: function at(this: ArrayLike<unknown>, index: number): unknown {
      const length = this.length >>> 0
      const relative = Math.trunc(index) || 0
      const k = relative >= 0 ? relative : length + relative
      if (k < 0 || k >= length) return undefined
      return this[k]
    },
    writable: true,
    enumerable: false,
    configurable: true,
  })
}

installArrayAtPolyfill()
