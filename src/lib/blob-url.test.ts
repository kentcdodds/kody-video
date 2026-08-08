import { describe, expect, it } from 'vitest'
import { createBlobUrlBinder } from './blob-url'

/** A revoked object URL is unfetchable — the observable half of revoke. */
function canFetch(url: string): Promise<boolean> {
  return fetch(url).then(
    () => true,
    () => false,
  )
}

describe('createBlobUrlBinder', () => {
  it('binds src to an object URL for the blob and revokes it on abort', async () => {
    const blob = new Blob(['clip-bytes'], { type: 'video/webm' })
    const binder = createBlobUrlBinder(() => blob)
    const node = document.createElement('img')
    const controller = new AbortController()

    binder.attach(node, controller.signal)
    const url = node.src
    expect(url.startsWith('blob:')).toBe(true)
    expect(await canFetch(url)).toBe(true)

    controller.abort()
    expect(await canFetch(url)).toBe(false)
  })

  it('re-binds when the blob identity changes between renders', async () => {
    let blob = new Blob(['first'])
    const binder = createBlobUrlBinder(() => blob)
    const node = document.createElement('img')
    const controller = new AbortController()

    binder.attach(node, controller.signal)
    const first = node.src

    blob = new Blob(['second'])
    binder.sync()
    const second = node.src
    expect(second).not.toBe(first)
    expect(await canFetch(first)).toBe(false)
    expect(await canFetch(second)).toBe(true)

    controller.abort()
    expect(await canFetch(second)).toBe(false)
  })

  it("keeps the URL alive when a stale teardown runs after a re-attach", async () => {
    // A remount can attach the replacement node BEFORE the old node's abort
    // fires. The stale teardown used to revoke the URL just handed to the
    // new node — every filmstrip thumb and the preview died at once.
    const blob = new Blob(['shared'])
    const binder = createBlobUrlBinder(() => blob)

    const oldNode = document.createElement('img')
    const oldController = new AbortController()
    binder.attach(oldNode, oldController.signal)

    const newNode = document.createElement('img')
    const newController = new AbortController()
    binder.attach(newNode, newController.signal)
    const url = newNode.src
    expect(await canFetch(url)).toBe(true)

    // The old node's teardown must now be a no-op.
    oldController.abort()
    expect(await canFetch(url)).toBe(true)

    // The current owner still cleans up.
    newController.abort()
    expect(await canFetch(url)).toBe(false)
  })
})
