import { buildPolicyIndex } from './build-index';
import { PolicyIndex } from './policy-index';

describe('PolicyIndex', () => {
  // Built once for the whole suite, as the server does at build time.
  const index = buildPolicyIndex();
  const sections = (query: string, limit = 3) => index.search(query, limit).matches.map((m) => m.section);

  describe('retrieval of distinct policy topics', () => {
    it.each([
      ['What is the payment deadline for the Spring term?', '2.2'],
      ['installment eligibility minimum balance', '3.1'],
      ['late fee for an overdue amount', '4.1'],
      ['refund after early withdrawal', '6.1'],
      ['duplicate payment retry idempotency key', '7.4'],
    ])('finds the right section first for "%s"', (query, expected) => {
      expect(sections(query)[0]).toBe(expected);
    });

    it('returns the section reference, heading, text and document ID needed for citations', () => {
      const result = index.search('late fee for an overdue amount', 1);

      expect(result).toMatchObject({
        document: 'University_Tuition_Policies.md',
        documentId: 'UNI-TUITION-2026-01',
        query: 'late fee for an overdue amount',
      });
      expect(result.matches[0]).toMatchObject({
        section: '4.1',
        heading: 'Late fee rule',
        parentHeading: 'Late fees',
        text: expect.stringContaining('2% one-time late fee'),
      });
      expect(result.matches[0].score).toBeGreaterThan(0);
    });
  });

  it('orders matches by descending score and respects the limit', () => {
    const { matches } = index.search('payment', 5);

    expect(matches).toHaveLength(5);
    const scores = matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('tolerates small spelling differences', () => {
    expect(sections('instalment plan')).toEqual(expect.arrayContaining(['3.4']));
  });

  it('returns no matches for a query made only of stop words or unknown terms', () => {
    expect(index.search('the of and').matches).toEqual([]);
    expect(index.search('xylophone').matches).toEqual([]);
  });

  it('gives the same results after a JSON round trip (build time -> server start)', () => {
    const reloaded = PolicyIndex.fromJSON(JSON.stringify(index));

    expect(reloaded.size).toBe(index.size);
    expect(reloaded.search('refund after early withdrawal')).toEqual(index.search('refund after early withdrawal'));
  });
});
