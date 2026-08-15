import { describe, expect, it } from 'vitest'
import { deriveProjectLocation, haversineMeters, medianPoint } from './geo'

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

describe('medianPoint', () => {
  it('rejects an empty list', () => {
    expect(() => medianPoint([])).toThrow(RangeError)
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

  it('uses the median of a tight city cluster', () => {
    const points = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7751, lng: -122.4192 },
      { lat: 37.7747, lng: -122.4196 },
      { lat: 37.7750, lng: -122.4190 },
    ]
    const loc = deriveProjectLocation(points)
    expect(loc).toEqual(medianPoint(points))
  })

  it('uses the median of the majority cluster and excludes a far outlier', () => {
    const cluster = [
      { lat: 48.8566, lng: 2.3522 },
      { lat: 48.86, lng: 2.36 },
      { lat: 48.85, lng: 2.34 },
    ]
    const outlier = { lat: -33.8688, lng: 151.2093 } // Sydney
    const loc = deriveProjectLocation([...cluster, outlier])
    expect(loc).toEqual(medianPoint(cluster))
  })

  it('falls back to the last geo clip when there is no majority cluster', () => {
    const first = { lat: 40.7128, lng: -74.006 } // NYC
    const second = { lat: 35.6762, lng: 139.6503 } // Tokyo
    const third = { lat: -33.8688, lng: 151.2093 } // Sydney
    expect(deriveProjectLocation([first, second, third])).toEqual(third)
  })
})
