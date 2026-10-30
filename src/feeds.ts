/**
 * Feed iterators with a checkpoint for the last fully consumed page.
 *
 * Mirrors the Python SDK's `FeedIterator`: events are deduplicated on `id`
 * within one run, and `nextCursor` only advances once every event of a page
 * has been handed out — so a run that stops partway through a page resumes
 * by replaying that page rather than skipping its unprocessed events.
 */

import type { FeedEvent } from './types.js';

/** The cursor fields every feed query shares. */
export interface FeedCursorQuery {
  cursor?: string | null;
  since?: string | null;
}

/** The page shape both feeds return. */
export interface FeedPage {
  data?: FeedEvent[];
  next_cursor: string;
  has_more: boolean;
}

/**
 * Yields feed events until `has_more` is false. Use it with `for await`, then
 * persist {@link FeedIterator.nextCursor} and pass it back as `cursor`, with
 * the same filters, on the next poll. The completed `.next()` result also
 * carries the final cursor as its `value`.
 */
export class FeedIterator<Q extends FeedCursorQuery = FeedCursorQuery>
  implements AsyncIterator<FeedEvent, string | undefined, undefined>, AsyncIterable<FeedEvent>
{
  #nextCursor: string | undefined;
  readonly #events: AsyncGenerator<FeedEvent, string | undefined, undefined>;

  constructor(fetchPage: (query: Q) => Promise<FeedPage>, query: Q) {
    this.#nextCursor = query.cursor ?? undefined;
    this.#events = this.#iterate(fetchPage, { ...query });
  }

  /**
   * Resume cursor for the last fully consumed page, including empty pages.
   * Starts at the supplied `cursor` (or `undefined`); stopping partway through
   * a page leaves it at that page's starting position.
   */
  get nextCursor(): string | undefined {
    return this.#nextCursor;
  }

  next(): Promise<IteratorResult<FeedEvent, string | undefined>> {
    return this.#events.next();
  }

  /** Stop without advancing past unconsumed events. `break` calls this. */
  return(): Promise<IteratorResult<FeedEvent, string | undefined>> {
    return this.#events.return(undefined);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async *#iterate(
    fetchPage: (query: Q) => Promise<FeedPage>,
    params: Q,
  ): AsyncGenerator<FeedEvent, string | undefined, undefined> {
    const seen = new Set<string>();
    // `since` only positions a fresh start; a cursor already carries the position.
    let query: Q = this.#nextCursor !== undefined ? { ...params, since: undefined } : params;
    for (;;) {
      const page = await fetchPage(query);
      for (const event of page.data ?? []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        yield event;
      }
      this.#nextCursor = page.next_cursor;
      if (!page.has_more) return page.next_cursor;
      query = { ...query, cursor: page.next_cursor, since: undefined };
    }
  }
}
