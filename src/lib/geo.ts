import type { ClipRecord } from './types'

const EARTH_RADIUS_M = 6_371_000
const CLUSTER_RADIUS_M = 5_000

/** Great-circle distance in metres between two WGS84 points. */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Pick a single project geotag from clip coordinates (timeline order).
 *
 * 1. Collect points with both lat and lng.
 * 2. For each point as a seed, form the subset within 5 km (haversine).
 * 3. Keep the largest such subset (stable on ties: first seed wins).
 * 4. If that subset is a majority (≥ 50%) of geo points, return its
 *    component-wise median (Photos-friendly pin, outlier-resistant);
 *    otherwise return the last geo clip's coordinates.
 *
 * Seeding (vs a single global centroid) is required so a far outlier cannot
 * yank the centroid outside the dense cluster and erase the majority.
 */
export function deriveProjectLocation(
  clips: Pick<ClipRecord, 'lat' | 'lng'>[],
): { lat: number; lng: number } | null {
  const points = clips.filter(
    (c): c is { lat: number; lng: number } =>
      typeof c.lat === 'number' &&
      typeof c.lng === 'number' &&
      Number.isFinite(c.lat) &&
      Number.isFinite(c.lng),
  )
  if (points.length === 0) return null
  if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng }

  let best: { lat: number; lng: number }[] = []
  for (const seed of points) {
    const cluster = points.filter((p) => haversineMeters(p, seed) <= CLUSTER_RADIUS_M)
    if (cluster.length > best.length) best = cluster
  }

  // Also accept a global-centroid inlier set when it is larger (covers the
  // maintainer's "centroid then 5 km" wording for tight groups).
  const centroid = {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length,
  }
  const aroundCentroid = points.filter((p) => haversineMeters(p, centroid) <= CLUSTER_RADIUS_M)
  if (aroundCentroid.length > best.length) best = aroundCentroid

  if (best.length * 2 >= points.length) return medianPoint(best)
  const last = points[points.length - 1]
  return { lat: last.lat, lng: last.lng }
}

/** Independent median of lat and lng — the typical pin for a tight cluster. */
export function medianPoint(
  points: { lat: number; lng: number }[],
): { lat: number; lng: number } {
  if (points.length === 0) {
    throw new RangeError('Expected at least one point')
  }
  return {
    lat: medianNumber(points.map((p) => p.lat)),
    lng: medianNumber(points.map((p) => p.lng)),
  }
}

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
