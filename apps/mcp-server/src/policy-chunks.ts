// Splits the policy Markdown document into searchable chunks.
// One chunk per "###" subsection; a "##" section without subsections becomes one chunk itself.

export interface PolicyChunk {
  /** Section number, e.g. "3.2" for a subsection or "9" for a section without subsections. */
  section: string;
  heading: string;
  /** Heading of the enclosing "##" section; null when the chunk is a whole "##" section. */
  parentHeading: string | null;
  text: string;
}

export interface PolicyDocument {
  /** File name, e.g. "University_Tuition_Policies.md". */
  document: string;
  /** Value of the "Document ID" line, e.g. "UNI-TUITION-2026-01". */
  documentId: string;
  chunks: PolicyChunk[];
}

const SECTION = /^##\s+(\d+)\.\s+(.+?)\s*$/;
const SUBSECTION = /^###\s+(\d+\.\d+)\s+(.+?)\s*$/;
const DOCUMENT_ID = /^\*\*Document ID:\*\*\s*(\S+)/m;

interface OpenChunk {
  section: string;
  heading: string;
  parentHeading: string | null;
  lines: string[];
}

/** Removes Markdown emphasis so the text reads cleanly in answers. */
function plainText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkPolicyDocument(markdown: string, document: string): PolicyDocument {
  const documentId = DOCUMENT_ID.exec(markdown)?.[1];
  if (!documentId) {
    throw new Error(`${document}: no "**Document ID:**" line found`);
  }

  const chunks: PolicyChunk[] = [];
  let parent: { section: string; heading: string; hasSubsections: boolean } | null = null;
  let open: OpenChunk | null = null;

  const close = (): void => {
    if (open) {
      const text = plainText(open.lines);
      if (text) {
        chunks.push({ section: open.section, heading: open.heading, parentHeading: open.parentHeading, text });
      }
    }
    open = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const section = SECTION.exec(line);
    if (section) {
      close();
      parent = { section: section[1], heading: section[2], hasSubsections: false };
      // Collect the section body; it is kept only if no subsection follows (see below).
      open = { section: section[1], heading: section[2], parentHeading: null, lines: [] };
      continue;
    }

    const subsection = SUBSECTION.exec(line);
    if (subsection && parent) {
      if (!parent.hasSubsections) {
        // The section has subsections: drop its short intro chunk, the subsections carry the content.
        open = null;
        parent.hasSubsections = true;
      }
      close();
      open = { section: subsection[1], heading: subsection[2], parentHeading: parent.heading, lines: [] };
      continue;
    }

    // Text before the first "##" (title and metadata) is not part of any chunk.
    open?.lines.push(line);
  }
  close();

  return { document, documentId, chunks };
}
