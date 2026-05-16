export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

export type SearchOptions = {
  maxResults?: number;
};

export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}
