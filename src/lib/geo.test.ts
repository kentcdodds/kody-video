import { describe, expect, it } from 'vitest'
import { deriveProjectLocation, haversineMeters } from './geo'

describe('haversineMeters', () => {
  it('returns ~0 for identical points', () => {
    expect(haversineMeters({ lat: 37.77, lng: -122.42 }, { lat: 37.77, lng: -122.42 })).toBe(0)
  })

  it('measures a short city hop in the right order of magnitude', () => {
    const d = haversineMeters(
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7849, lng: -122.4094 },
    )
    expect(d).toBeGreaterThan(1000)
    expect(d).toBeLessThan(2000)
  })
})

describe('deriveProjectLocation', () => {
  it('returns null when there are no clips', () => {
    expect(deriveProjectLocation([])).toBeNull()
  })

  it('returns null when no clips have both lat and lng', () => {
    expect(deriveProjectLocation([{ lat: 1 }, { lng: 2 }, {}])).toBeNull()
  })

  it('returns the single geo clip as-is', () => {
    expect(deriveProjectLocation([{ lat: 40.7, lng: -74.0 }])).toEqual({
      lat: 40.7,
      lng: -74.0,
    })
  })

  it('averages a tight city cluster', () => {
    const points = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7751, lng: -122.4192 },
      { lat: 37.7747, lng: -122.4196 },
      { lat: 37.7750, lng: -122.4190 },
    ]
    const loc = deriveProjectLocation(points)
    expect(loc).not.toBeNull()
    const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length
    const avgLng = points.reduce((s, p) => s + p.lng, 0) / points.length
    expect(loc!.lat).toBeCloseTo(avgLat, 10)
    expect(loc!.lng).toBeCloseTo(avgLng, 10)
  })

  it('averages the majority cluster and excludes a far outlier', () => {
    // Asymmetric so the result cannot accidentally equal the first clip alone.
    const cluster = [
      { lat: 48.8566, lng: 2.3522 },
      { lat: 48.8600, lng: 2.3600 },
      { lat: 48.8500, lng: 2.3400 },
    ]
    const outlier = { lat: -33.8688, lng: 151.2093 } // Sydney
    const loc = deriveProjectLocation([...cluster, outlier])
    expect(loc).not.toBeNull()
    const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length
    const avgLng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length
    expect(loc!.lat).toBeCloseTo(avgLat, 10)
    expect(loc!.lng).toBeCloseTo(avgLng, 10)
    expect(loc).not.toEqual(cluster[0])
  })

  it('falls back to the first geo clip when there is no majority cluster', () => {
    const first = { lat: 40.7128, lng: -74.006 } // NYC
    const second = { lat: 35.6762, lng: 139.6503 } // Tokyo
    expect(deriveProjectLocation([first, second])).toEqual(first)
  })
})
