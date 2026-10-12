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
