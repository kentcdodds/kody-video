import 'fake-indexeddb/auto'
import { IDBKeyRange } from 'fake-indexeddb'

// Ensure IDBKeyRange is available for idb index queries in Node.
if (typeof globalThis.IDBKeyRange === 'undefined') {
  globalThis.IDBKeyRange = IDBKeyRange
}
