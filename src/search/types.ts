export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

export type SearchOptions = {
  maxResults?: number;
  // A provider that hit a check only a human can clear reports it here: `raised` when it has put
  // the browser in front of the user and is waiting, `cleared` when the check passed and the
  // search went on. The provider owns the waiting; the caller owns what the user sees (#238).
  onChallenge?: (state: 'raised' | 'cleared') => void;
};

export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

// A failure that is a property of the PROVIDER, not the query: no browser to drive, a bot check,
// every upstream engine refused. Re-querying cannot succeed, so the tool latches it for the turn
// instead of letting the model reword against a wall that refuses every variant identically.
// Distinguished from an ordinary throw, which stays query-level (one unparseable page, say) and
// leaves the next search free to run.
export class SearchUnavailableError extends Error {
  // Optional user-facing next step. Kept separate from `message` because the two have different
  // audiences: the message goes to the model (stop searching), the remedy to the user (here is the
  // switch to flip) — and the model cannot set an environment variable, so telling it about one is
  // context noise it can only ignore.
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SearchUnavailableError';
    this.remedy = remedy;
  }
}
