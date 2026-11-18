import { readFileSync } from 'node:fs';
import MiniSearch, { Options } from 'minisearch';
import { PolicyChunk, PolicyDocument } from './policy-chunks';

// Full-text BM25 index over the policy chunks (MiniSearch).
// The index is built once at build time (build-index.ts) and loaded from JSON when the server starts.

export interface PolicyMatch extends PolicyChunk {
  /** Relevance score (BM25 with field boosts), rounded to 2 decimals. Higher is better. */
  score: number;
}

export interface PolicySearchResult {
  document: string;
  documentId: string;
  query: string;
  matches: PolicyMatch[];
}

interface IndexedChunk extends PolicyChunk {
  id: number;
}

/** Serialized form written to dist/policy-index.json. */
interface SerializedIndex {
  document: string;
  documentId: string;
  chunks: IndexedChunk[];
  miniSearch: unknown;
}

// Common words that carry no meaning for policy search ("When is the ...", "Can I ...").
const STOP_WORDS = new Set(
  (
    'a an and are as at be by can could do does for from has have how i if in into is it its me my of on or ' +
    'our please should tell that the their them there this to was we were what when where which will with ' +
    'would you your'
  ).split(' '),
);

// The same options are needed to build and to load the index (functions are not serialized).
const MINI_SEARCH_OPTIONS: Options<IndexedChunk> = {
  fields: ['heading', 'parentHeading', 'text'],
  processTerm: (term) => {
    const lower = term.toLowerCase();
    return STOP_WORDS.has(lower) ? null : lower;
  },
  searchOptions: {
    boost: { heading: 3, parentHeading: 1.5 },
    prefix: true,
    fuzzy: 0.2,
    combineWith: 'OR',
  },
};

export class PolicyIndex {
  private constructor(
    readonly document: string,
    readonly documentId: string,
    private readonly chunks: IndexedChunk[],
    private readonly miniSearch: MiniSearch<IndexedChunk>,
  ) {}

  static build({ document, documentId, chunks }: PolicyDocument): PolicyIndex {
    const indexed = chunks.map((chunk, id) => ({ ...chunk, id }));
    const miniSearch = new MiniSearch<IndexedChunk>(MINI_SEARCH_OPTIONS);
    miniSearch.addAll(indexed);
    return new PolicyIndex(document, documentId, indexed, miniSearch);
  }

  static fromJSON(json: string): PolicyIndex {
    const data = JSON.parse(json) as SerializedIndex;
    const miniSearch = MiniSearch.loadJSON<IndexedChunk>(JSON.stringify(data.miniSearch), MINI_SEARCH_OPTIONS);
    return new PolicyIndex(data.document, data.documentId, data.chunks, miniSearch);
  }

  static load(file: string): PolicyIndex {
    return PolicyIndex.fromJSON(readFileSync(file, 'utf8'));
  }

  toJSON(): SerializedIndex {
    return {
      document: this.document,
      documentId: this.documentId,
      chunks: this.chunks,
      miniSearch: this.miniSearch.toJSON(),
    };
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, limit = 3): PolicySearchResult {
    const matches = this.miniSearch
      .search(query)
      .slice(0, limit)
      .map(({ id, score }) => {
        const { section, heading, parentHeading, text } = this.chunks[id as number];
        return { section, heading, parentHeading, text, score: Math.round(score * 100) / 100 };
      });
    return { document: this.document, documentId: this.documentId, query, matches };
  }
}
