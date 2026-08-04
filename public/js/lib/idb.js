/**
 * Minimal promise wrapper over raw IndexedDB, exposing exactly the surface
 * this app uses (a small `idb`-compatible subset): openDB with an upgrade
 * callback, promise-returning get/put/delete/getAllFromIndex, and explicit
 * transactions with `objectStore()`, `store`, and a `done` promise.
 * Web-standard IndexedDB underneath — no dependencies.
 */

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function wrapStore(store) {
  return {
    get: (key) => requestToPromise(store.get(key)),
    put: (value) => requestToPromise(store.put(value)),
    delete: (key) => requestToPromise(store.delete(key)),
    getAll: () => requestToPromise(store.getAll()),
    createIndex: (name, keyPath, options) => store.createIndex(name, keyPath, options),
  }
}

function wrapTransaction(tx) {
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
    tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'))
  })
  // A transaction's failure must be observable ONLY through `done` (callers
  // race it with their requests) — an untouched `done` on an errored tx
  // otherwise fires unhandledrejection.
  done.catch(() => undefined)
  const names = tx.objectStoreNames
  return {
    objectStore: (name) => wrapStore(tx.objectStore(name)),
    // `tx.store` is the single-store convenience, like the idb library's.
    get store() {
      return names.length === 1 ? wrapStore(tx.objectStore(names[0])) : undefined
    },
    done,
  }
}

function wrapDatabase(db) {
  return {
    get: (storeName, key) =>
      requestToPromise(db.transaction(storeName).objectStore(storeName).get(key)),
    put: (storeName, value) =>
      requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value)),
    delete: (storeName, key) =>
      requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key)),
    getAllFromIndex: (storeName, indexName) =>
      requestToPromise(db.transaction(storeName).objectStore(storeName).index(indexName).getAll()),
    transaction: (storeNames, mode = 'readonly') => wrapTransaction(db.transaction(storeNames, mode)),
    close: () => db.close(),
  }
}

export function openDB(name, version, { upgrade } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      upgrade?.({
        createObjectStore: (storeName, options) => wrapStore(db.createObjectStore(storeName, options)),
      })
    }
    request.onsuccess = () => resolve(wrapDatabase(request.result))
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
  })
}
