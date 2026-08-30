import { renderSVG } from 'uqr'

/** SVG QR for a pairing URL, with a viewBox so CSS can scale it reliably. */
export function qrSvgMarkup(href: string): string {
  let svg = renderSVG(href, {
    ecc: 'M',
    pixelSize: 8,
    whiteColor: '#f3f5f4',
    blackColor: '#1a2824',
  })
  if (!/viewBox=/.test(svg)) {
    const width = svg.match(/\bwidth="(\d+(?:\.\d+)?)"/)?.[1]
    const height = svg.match(/\bheight="(\d+(?:\.\d+)?)"/)?.[1]
    if (width && height) {
      svg = svg.replace('<svg', `<svg viewBox="0 0 ${width} ${height}"`)
    }
  }
  return svg
}

export function qrSvgDataUrl(href: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvgMarkup(href))}`
}