/**
 * Full-screen export progress, OK Video style: the camera/editor is hidden
 * (and the camera released) while the engines show the frame currently
 * being encoded above a big progress bar.
 */

import { define, h, KvElement } from '../dom.js'

export class KvExportOverlay extends KvElement {
  #bar = null
  #percentLabel = null

  render() {
    const { projectName, bindPreviewCanvas } = this.props
    const canvas = h('canvas', { className: 'export-preview-canvas' })
    bindPreviewCanvas(canvas)
    this.signal.addEventListener('abort', () => bindPreviewCanvas(null))

    this.#bar = h('span', { style: { width: '0%' } })
    this.#percentLabel = h('p', { className: 'export-percent', 'aria-live': 'polite' }, '0%')

    this.replaceChildren(
      h(
        'div',
        { className: 'export-overlay', role: 'dialog', 'aria-label': 'Exporting video' },
        h('div', { className: 'export-overlay-stage' }, canvas),
        h(
          'div',
          { className: 'export-overlay-info' },
          h('h2', null, 'Exporting your video…'),
          h('p', { className: 'muted' }, `${projectName} — keep the app open`),
          h('div', { className: 'progress-bar', 'aria-label': 'Export progress' }, this.#bar),
          this.#percentLabel,
        ),
      ),
    )
    this.setProgress(this.props.progress ?? 0)
  }

  /** Imperative: progress ticks many times a second — no re-render. */
  setProgress(ratio) {
    if (!this.#bar) return
    const percent = Math.round(ratio * 100)
    this.#bar.style.width = `${percent}%`
    this.#percentLabel.textContent = `${percent}%`
  }
}
define('kv-export-overlay', KvExportOverlay)
