import { describe, expect, it } from 'vitest';
import { buildPrompt, formatCitations, REFUSAL } from '../lambda/grounding';

const evidence = [
  { id: 1, text: 'Encryption at rest helps protect stored data.', source: 's3://docs/docs/security.md' },
  { id: 2, text: 'Retries with backoff improve resilience.', source: 's3://docs/docs/reliability.md' },
];
describe('grounding helpers', () => {
  it('builds a bounded prompt with numbered, untrusted excerpts', () => {
    const prompt = buildPrompt('How to secure data?', evidence);
    expect(prompt).toContain('Question: How to secure data?');
    expect(prompt).toContain('[1] Encryption at rest');
    expect(prompt).toContain('untrusted data');
    expect(buildPrompt('x', [{ ...evidence[0], text: 'a'.repeat(2000) }])).not.toContain('a'.repeat(1501));
  });
  it('extracts distinct citations in order from model answer', () => {
    expect(formatCitations('Use backoff [2] and encryption [1], backoff [2].', evidence)).toEqual([
      { id: 2, source: evidence[1].source }, { id: 1, source: evidence[0].source },
    ]);
  });
  it('rejects missing or invented citations', () => {
    expect(formatCitations('Unsupported claim.', evidence)).toBeNull();
    expect(formatCitations('A [1], invented [3]', evidence)).toBeNull();
    expect(REFUSAL).toContain('cannot answer');
  });
});
