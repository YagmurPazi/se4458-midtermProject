import { readFileSync } from 'node:fs';
import { POLICY_FILE } from './build-index';
import { chunkPolicyDocument } from './policy-chunks';

describe('chunkPolicyDocument', () => {
  describe('with the real policy document', () => {
    const doc = chunkPolicyDocument(readFileSync(POLICY_FILE, 'utf8'), 'University_Tuition_Policies.md');
    const bySection = (section: string) => doc.chunks.find((chunk) => chunk.section === section);

    it('reads the document ID from the metadata', () => {
      expect(doc.documentId).toBe('UNI-TUITION-2026-01');
      expect(doc.document).toBe('University_Tuition_Policies.md');
    });

    it('creates one chunk per ### subsection and one per ## section without subsections', () => {
      // §1 and §9 have no subsections; §2–§8 have 3+4+3+2+3+4+4 = 23 subsections.
      expect(doc.chunks).toHaveLength(25);
      expect(doc.chunks.map((chunk) => chunk.section)).toEqual([
        '1',
        '2.1', '2.2', '2.3',
        '3.1', '3.2', '3.3', '3.4',
        '4.1', '4.2', '4.3',
        '5.1', '5.2',
        '6.1', '6.2', '6.3',
        '7.1', '7.2', '7.3', '7.4',
        '8.1', '8.2', '8.3', '8.4',
        '9',
      ]);
    });

    it('keeps the heading, the parent heading and the plain text of a subsection', () => {
      expect(bySection('3.2')).toEqual({
        section: '3.2',
        heading: 'Number and size of installments',
        parentHeading: 'Installment policy',
        text: expect.stringContaining('divided into up to three installments'),
      });
    });

    it('treats a section without subsections as one chunk without a parent', () => {
      expect(bySection('9')).toMatchObject({ heading: 'Guidance for AI/MCP implementation', parentHeading: null });
      expect(bySection('1')?.text).toContain('Outstanding balance');
    });

    it('removes Markdown emphasis and leaves out the title block', () => {
      expect(doc.chunks.every((chunk) => !chunk.text.includes('**'))).toBe(true);
      expect(doc.chunks.some((chunk) => chunk.text.includes('Fictitious teaching document'))).toBe(false);
    });
  });

  it('handles a small document, dropping a section intro when subsections follow', () => {
    const markdown = [
      '# Title',
      '**Document ID:** DOC-1',
      '## 1. Alpha',
      'Alpha text.',
      '## 2. Beta',
      'Intro that is covered by the subsections.',
      '### 2.1 First',
      'First **bold** text.',
      '### 2.2 Second',
      'Second text.',
    ].join('\n');

    expect(chunkPolicyDocument(markdown, 'doc.md').chunks).toEqual([
      { section: '1', heading: 'Alpha', parentHeading: null, text: 'Alpha text.' },
      { section: '2.1', heading: 'First', parentHeading: 'Beta', text: 'First bold text.' },
      { section: '2.2', heading: 'Second', parentHeading: 'Beta', text: 'Second text.' },
    ]);
  });

  it('rejects a document without a Document ID line', () => {
    expect(() => chunkPolicyDocument('## 1. Alpha\ntext', 'doc.md')).toThrow('Document ID');
  });
});
