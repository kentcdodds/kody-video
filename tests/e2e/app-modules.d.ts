/**
 * Specs seed and inspect app state by dynamically importing app modules
 * INSIDE page.evaluate — those imports resolve in the browser through
 * vite's dev server, not through tsc, so they're declared loosely here.
 * (This is also why they can't be top-of-file imports: the callback body is
 * serialized and executed in the page, a different runtime entirely.)
 */
declare module '/src/lib/*' {
  const mod: any
  export = mod
}
