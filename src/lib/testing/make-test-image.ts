/**
 * Deterministic fixture photo for the e2e suite (imported in-page through
 * the vite dev server; never referenced by app code, so it ships nowhere).
 */
export async function makeTestImageBlob(
  width = 320,
  height = 568,
  color = '#3aa76d',
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#fff'
  ctx.font = '48px sans-serif'
  ctx.fillText('photo', 24, 64)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) throw new Error('Test image encode produced no bytes')
  return blob
}
