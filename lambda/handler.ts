import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { buildPrompt, formatCitations, REFUSAL, SYSTEM_PROMPT, type Evidence } from './grounding';

const agent = new BedrockAgentRuntimeClient({});
const runtime = new BedrockRuntimeClient({});
const response = (statusCode: number, body: object) => ({
  statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export async function handler(event: { body?: string | null }) {
  let question: unknown;
  try { question = JSON.parse(event.body ?? '').question; } catch { return response(400, { error: 'Expected JSON with a question.' }); }
  if (typeof question !== 'string' || !question.trim() || question.length > 500) {
    return response(400, { error: 'Question must be 1–500 characters.' });
  }
  try {
    const retrieved = await agent.send(new RetrieveCommand({
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
      retrievalQuery: { text: question.trim() },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 4 } },
    }));
    const evidence: Evidence[] = (retrieved.retrievalResults ?? []).flatMap(result => {
      const text = result.content?.text?.trim();
      const source = result.location?.s3Location?.uri;
      return text && source?.startsWith('s3://') ? [{ id: 0, text, source }] : [];
    }).map((item, i) => ({ ...item, id: i + 1 }));
    if (!evidence.length) return response(200, { answer: REFUSAL, citations: [] });

    const generated = await runtime.send(new ConverseCommand({
      modelId: process.env.GENERATION_MODEL_ID!,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: buildPrompt(question.trim(), evidence) }] }],
      inferenceConfig: { maxTokens: 400, temperature: 0 },
      guardrailConfig: { guardrailIdentifier: process.env.GUARDRAIL_ID!, guardrailVersion: process.env.GUARDRAIL_VERSION! },
    }));
    if (generated.stopReason === 'guardrail_intervened') {
      return response(200, { answer: 'This question or answer was blocked by the safety policy.', citations: [] });
    }
    if (generated.stopReason !== 'end_turn') return response(200, { answer: REFUSAL, citations: [] });
    const answer = generated.output?.message?.content?.map(part => part.text ?? '').join('').trim() ?? '';
    if (answer === REFUSAL) return response(200, { answer: REFUSAL, citations: [] });
    const citations = formatCitations(answer, evidence);
    if (!citations) return response(200, { answer: REFUSAL, citations: [] });
    return response(200, { answer, citations });
  } catch (error) {
    console.error('Bedrock request failed', error instanceof Error ? error.name : 'UnknownError');
    return response(503, { error: 'Assistant temporarily unavailable.' });
  }
}
