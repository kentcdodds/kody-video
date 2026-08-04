/**
 * Minimal promise wrapper over raw IndexedDB, exposing the `idb`-compatible
 * subset this app uses: openDB with an upgrade callback, promise-returning
 * get/put/delete/getAllFromIndex, and explicit transactions with
 * `objectStore()`, `store`, and a `done` promise. Web-standard IndexedDB
 * underneath — no dependencies. The generics mirror idb's DBSchema pattern
 * closely enough that the storage layer keeps its original types.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DBSchema {
  [store: string]: {
    key: IDBValidKey
    value: unknown
    indexes?: Record<string, IDBValidKey>
  }
}

export type StoreNames<S extends DBSchema> = Extract<keyof S, string>
export type StoreKey<S extends DBSchema, N extends StoreNames<S>> = S[N]['key']
export type StoreValue<S extends DBSchema, N extends StoreNames<S>> = S[N]['value']
export type IndexNames<S extends DBSchema, N extends StoreNames<S>> = Extract<
  keyof S[N]['indexes'],
  string
>

export interface WrappedStore<S extends DBSchema, N extends StoreNames<S>> {
  get(key: StoreKey<S, N>): Promise<StoreValue<S, N> | undefined>
  put(value: StoreValue<S, N>): Promise<IDBValidKey>
  delete(key: StoreKey<S, N>): Promise<void>
  getAll(): Promise<Array<StoreValue<S, N>>>
  createIndex(name: string, keyPath: string | string[], options?: IDBIndexParameters): IDBIndex
}

export interface WrappedTransaction<S extends DBSchema, N extends StoreNames<S>> {
  objectStore<M extends N>(name: M): WrappedStore<S, M>
  /** Single-store convenience, like the idb library's `tx.store`. */
  readonly store: WrappedStore<S, N>
  readonly done: Promise<void>
}

export interface IDBPDatabase<S extends DBSchema> {
  get<N extends StoreNames<S>>(store: N, key: StoreKey<S, N>): Promise<StoreValue<S, N> | undefined>
  put<N extends StoreNames<S>>(store: N, value: StoreValue<S, N>): Promise<IDBValidKey>
  delete<N extends StoreNames<S>>(store: N, key: StoreKey<S, N>): Promise<void>
  getAllFromIndex<N extends StoreNames<S>>(
    store: N,
    index: IndexNames<S, N>,
  ): Promise<Array<StoreValue<S, N>>>
  transaction<N extends StoreNames<S>>(
    storeNames: N | N[],
    mode?: IDBTransactionMode,
  ): WrappedTransaction<S, N>
  close(): void
}

export interface UpgradeDB<S extends DBSchema> {
  createObjectStore<N extends StoreNames<S>>(
    name: N,
    options?: IDBObjectStoreParameters,
  ): WrappedStore<S, N>
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function wrapStore(store: IDBObjectStore): WrappedStore<any, any> {
  return {
    get: (key) => requestToPromise(store.get(key)),
    put: (value) => requestToPromise(store.put(value)),
    delete: (key) => requestToPromise(store.delete(key)) as Promise<void>,
    getAll: () => requestToPromise(store.getAll()),
    createIndex: (name, keyPath, options) => store.createIndex(name, keyPath, options),
  }
}

function wrapTransaction(tx: IDBTransaction): WrappedTransaction<any, any> {
  const done = new Promise<void>((resolve, reject) => {
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
    get store() {
      return wrapStore(tx.objectStore(names[0]!))
    },
    done,
  }
}

export function openDB<S extends DBSchema>(
  name: string,
  version: number,
  { upgrade }: { upgrade?: (db: UpgradeDB<S>) => void } = {},
): Promise<IDBPDatabase<S>> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      upgrade?.({
        createObjectStore: (storeName, options) =>
          wrapStore(db.createObjectStore(storeName, options)),
      })
    }
    request.onsuccess = () => {
      const db = request.result
      resolve({
        get: (storeName, key) =>
          requestToPromise(db.transaction(storeName).objectStore(storeName).get(key)),
        put: (storeName, value) =>
          requestToPromise(
            db.transaction(storeName, 'readwrite').objectStore(storeName).put(value),
          ),
        delete: (storeName, key) =>
          requestToPromise(
            db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key),
          ) as Promise<void>,
        getAllFromIndex: (storeName, indexName) =>
          requestToPromise(
            db.transaction(storeName).objectStore(storeName).index(indexName).getAll(),
          ),
        transaction: (storeNames, mode = 'readonly') =>
          wrapTransaction(db.transaction(storeNames, mode)),
        close: () => db.close(),
      })
    }
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
  })
}
