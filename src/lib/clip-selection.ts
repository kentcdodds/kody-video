/** After a delete, keep the playhead on a neighbor instead of jumping to the end. */

export function clipIdAfterDelete<T extends string>(
  clipIds: readonly T[],
  deletedId: T,
): T | null {
  const index = clipIds.indexOf(deletedId)
  if (index < 0) return clipIds.at(-1) ?? null
  return clipIds[index + 1] ?? clipIds[index - 1] ?? null
}
