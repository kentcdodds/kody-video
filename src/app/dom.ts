/**
 * Tiny DOM helpers — the app's entire "framework". Web components with
 * plain DOM building; no virtual DOM, no dependencies.
 */

export type Child = Node | string | number | false | null | undefined | Child[]

export type ElementProps = {
  /** Custom-element inputs, set as one object property. */
  props?: unknown
  dataset?: Record<string, string>
  style?: Partial<CSSStyleDeclaration>
} & {
  [key: string]: unknown
}

/**
 * Hyperscript-style element builder.
 * `h('button', { className: 'btn', onclick, disabled: true }, children)`
 * - `on*` props become event listeners
 * - `className`, `id`, `value`, `disabled`, … are set as properties when the
 *   element has them, otherwise as attributes
 * - `dataset` and `style` accept objects
 * - children: nodes, strings, arrays, or null/undefined (skipped)
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K]
export function h(tag: string, props?: ElementProps | null, ...children: Child[]): HTMLElement
export function h(tag: string, props?: ElementProps | null, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue
      if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2), value as EventListener)
      } else if (key === 'dataset') {
        Object.assign(element.dataset, value)
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(element.style, value)
      } else if (key === 'props') {
        ;(element as KvElement<unknown>).props = value
      } else if (key in element && key !== 'list' && key !== 'form') {
        ;(element as unknown as Record<string, unknown>)[key] = value
      } else {
        element.setAttribute(key, value === true ? '' : String(value))
      }
    }
  }
  appendChildren(element, children)
  return element
}

export function appendChildren(element: Element, children: Child[]): void {
  for (const child of (children as unknown[]).flat(Infinity) as Array<Exclude<Child, Child[]>>) {
    if (child === null || child === undefined || child === false) continue
    element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Parse a trusted HTML string into its first node (static markup only). */
export function fromHtml<T extends Element = HTMLElement>(html: string): T {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const node = template.content.firstElementChild
  if (!node) throw new Error('fromHtml: markup produced no element')
  return node as T
}

/**
 * Base class for the app's web components.
 * - `this.props` is assigned by the parent before insertion
 * - `connectedCallback` creates an AbortController (`this.signal`) and calls
 *   `render()`; `disconnectedCallback` aborts it and revokes blob URLs
 * - `update()` re-renders (components that must not rebuild live media
 *   override it with imperative syncs instead)
 */
export class KvElement<P = void> extends HTMLElement {
  /** Assigned by the parent before the element is inserted. */
  props!: P

  #abort: AbortController | null = null
  #blobUrls = new Map<Blob, string>()

  get signal(): AbortSignal {
    return this.#abort?.signal ?? AbortSignal.abort()
  }

  /** One-time setup on (re)connect, before the first render. */
  mounted?(): void
  /** Build or rebuild this component's DOM. */
  render?(): void

  connectedCallback(): void {
    if (this.#abort && !this.#abort.signal.aborted) return
    this.#abort = new AbortController()
    this.mounted?.()
    this.render?.()
  }

  disconnectedCallback(): void {
    // Wait a microtask: reparenting (replaceChildren shuffles) must not tear
    // the component down when it is immediately reconnected.
    queueMicrotask(() => {
      if (this.isConnected) return
      this.#abort?.abort()
      this.#abort = null
      for (const url of this.#blobUrls.values()) URL.revokeObjectURL(url)
      this.#blobUrls.clear()
    })
  }

  update(): void {
    if (this.isConnected) this.render?.()
  }

  /** Object URL for a blob, cached for this element's lifetime. */
  blobUrl(blob: Blob): string {
    let url = this.#blobUrls.get(blob)
    if (!url) {
      url = URL.createObjectURL(blob)
      this.#blobUrls.set(blob, url)
    }
    return url
  }
}

/** Define a custom element once (survives double imports). */
export function define(name: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(name)) customElements.define(name, ctor)
}
