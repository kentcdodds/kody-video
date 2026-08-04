/**
 * Tiny DOM helpers — the app's entire "framework". Web components with
 * plain DOM building; no virtual DOM, no dependencies.
 */
export function h(tag, props, ...children) {
    const element = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined)
                continue;
            if (key.startsWith('on') && typeof value === 'function') {
                element.addEventListener(key.slice(2), value);
            }
            else if (key === 'dataset') {
                Object.assign(element.dataset, value);
            }
            else if (key === 'style' && typeof value === 'object') {
                Object.assign(element.style, value);
            }
            else if (key === 'props') {
                ;
                element.props = value;
            }
            else if (key in element && key !== 'list' && key !== 'form') {
                ;
                element[key] = value;
            }
            else {
                element.setAttribute(key, value === true ? '' : String(value));
            }
        }
    }
    appendChildren(element, children);
    return element;
}
export function appendChildren(element, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false)
            continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}
/** Parse a trusted HTML string into its first node (static markup only). */
export function fromHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const node = template.content.firstElementChild;
    if (!node)
        throw new Error('fromHtml: markup produced no element');
    return node;
}
/**
 * Base class for the app's web components.
 * - `this.props` is assigned by the parent before insertion
 * - `connectedCallback` creates an AbortController (`this.signal`) and calls
 *   `render()`; `disconnectedCallback` aborts it and revokes blob URLs
 * - `update()` re-renders (components that must not rebuild live media
 *   override it with imperative syncs instead)
 */
export class KvElement extends HTMLElement {
    /** Assigned by the parent before the element is inserted. */
    props;
    #abort = null;
    #blobUrls = new Map();
    get signal() {
        return this.#abort?.signal ?? AbortSignal.abort();
    }
    connectedCallback() {
        if (this.#abort && !this.#abort.signal.aborted)
            return;
        this.#abort = new AbortController();
        this.mounted?.();
        this.render?.();
    }
    disconnectedCallback() {
        // Wait a microtask: reparenting (replaceChildren shuffles) must not tear
        // the component down when it is immediately reconnected.
        queueMicrotask(() => {
            if (this.isConnected)
                return;
            this.#abort?.abort();
            this.#abort = null;
            for (const url of this.#blobUrls.values())
                URL.revokeObjectURL(url);
            this.#blobUrls.clear();
        });
    }
    update() {
        if (this.isConnected)
            this.render?.();
    }
    /** Object URL for a blob, cached for this element's lifetime. */
    blobUrl(blob) {
        let url = this.#blobUrls.get(blob);
        if (!url) {
            url = URL.createObjectURL(blob);
            this.#blobUrls.set(blob, url);
        }
        return url;
    }
}
/** Define a custom element once (survives double imports). */
export function define(name, ctor) {
    if (!customElements.get(name))
        customElements.define(name, ctor);
}
