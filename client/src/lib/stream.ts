/**
 * The database version this page has actually received: from a full load or from the live-update
 * stream. The page's own changes also come back with new versions, but those don't count here:
 * changes made by others while the stream was down only arrive by reloading.
 */
export class StreamVersion {
  private seen = 0;

  /** A full load brought the page to exactly this version. */
  loaded(version: number) {
    this.seen = version;
  }

  /** A change arrived over the stream. */
  received(version: number) {
    this.seen = Math.max(this.seen, version);
  }

  /** On (re)connecting the server reports its version; anything else means changes may be missing. */
  missedChanges(serverVersion: number) {
    return serverVersion !== this.seen;
  }
}

/**
 * Fetch the whole database, but never one older than the page already shows: a live update (or
 * the response to our own change) can arrive while the request is in flight, and replacing the
 * page with the older copy would undo it. Such a copy is dropped and fetched again, a few times.
 */
export async function loadFresh<T extends { version: number }>(fetchDb: () => Promise<T>, pageVersion: () => number, attempts = 3): Promise<T> {
  let db = await fetchDb();
  for (let i = 1; i < attempts && db.version < pageVersion(); i++) db = await fetchDb();
  return db;
}
