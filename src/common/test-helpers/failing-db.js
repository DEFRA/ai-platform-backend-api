/**
 * A `db` that is the real one in every way but one: the given method of the
 * given collection rejects with `error`. For a driver failure (a lost
 * connection) that a real MongoDB cannot be made to produce on demand. It
 * wraps the `db` the service is handed, so no driver code is patched.
 * @param {import('mongodb').Db} db
 * @param {string} collectionName
 * @param {string} method
 * @param {Error} error
 * @returns {import('mongodb').Db}
 */
export function dbFailingOn(db, collectionName, method, error) {
  const bound = (target, property) => {
    const value = Reflect.get(target, property)

    return typeof value === 'function' ? value.bind(target) : value
  }
  const failing = (collection) =>
    new Proxy(collection, {
      get: (target, property) =>
        property === method
          ? () => Promise.reject(error)
          : bound(target, property)
    })

  return new Proxy(db, {
    get: (target, property) =>
      property === 'collection'
        ? (name) =>
            name === collectionName
              ? failing(target.collection(name))
              : target.collection(name)
        : bound(target, property)
  })
}
