import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chunkPolicyDocument } from './policy-chunks';
import { PolicyIndex } from './policy-index';

// Build step (npm run build): chunks the policy document and writes the search index to dist/.
// The server loads this file at startup, so nothing is indexed per question.

export const POLICY_FILE = join(__dirname, '..', 'data', 'University_Tuition_Policies.md');
export const INDEX_FILE = join(__dirname, 'policy-index.json');

export function buildPolicyIndex(policyFile = POLICY_FILE): PolicyIndex {
  return PolicyIndex.build(chunkPolicyDocument(readFileSync(policyFile, 'utf8'), basename(policyFile)));
}

if (require.main === module) {
  const index = buildPolicyIndex();
  writeFileSync(INDEX_FILE, JSON.stringify(index));
  console.log(`Indexed ${index.size} chunks of ${index.document} (${index.documentId}) -> ${INDEX_FILE}`);
}
