// @author Tijn
// @date 2026-05-02

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent } from 'langchain';
import { hnswIndexImpl } from '../text-embedding/hnsw-index.mjs';
import { getRelatedDocuments as getRelatedDocumentsFn } from './tools.mjs';
import { MemorySaver } from '@langchain/langgraph';
import { threadId } from 'worker_threads';

/**
 * Options for creating the RAG agent.
 */
export type RagAgentOptions = {
  /** An opened HNSW index instance to use for retrieval. */
  hnswIndex: hnswIndexImpl;
  /** Optional model name override. */
  modelName?: string;
  /** Number of documents to retrieve by default. */
  topK?: number;
  /** When true, skip hnsw.init() and hnsw.open() — use when the index is already open. */
  skipHnswInit?: boolean;
};

type RagAgentResponse = {
  answer: string;
  sources: Array<{ id: string; name: string }>;
};

type LangChainMessage = {
  _getType(): string;
  content: unknown;
};

type RagAgentRuntime = {
  invoke(
    input: { messages: Array<{ role: 'user'; content: string }> },
    config: { configurable: { thread_id: string } },
  ): Promise<{ messages: LangChainMessage[] }>;
};

const SYSTEM_PROMPT = `You are a Retrieval-Augmented Generation assistant.

Capabilities:
- Use the tool 'getRelatedDocuments' to fetch supporting documents from the knowledge base.
- When answering, always include a "Provenance" section listing each cited document's id and a one-line excerpt (max 200 characters).
- If you cannot answer from retrieved documents, respond: "I don't know based on the available documents. You can ask me to retrieve more or provide more context." Do not fabricate answers.
- Be concise and prefer bullet lists for step-by-step instructions.`;

export class RagAgent {
  private hnsw: hnswIndexImpl;
  private modelName: string;
  private topK: number;
  private agent: RagAgentRuntime | null;
  private memory = new MemorySaver();

  private skipHnswInit: boolean;

  constructor(opts: RagAgentOptions) {
    this.hnsw = opts.hnswIndex;
    this.modelName = opts.modelName ?? process.env['CLAUDE_MODEL'] ?? 'claude-haiku-4-5';
    this.topK = opts.topK ?? 5;
    this.agent = null;
    this.skipHnswInit = opts.skipHnswInit ?? false;
  }

  /**
   * We define the tool as a property using the tool() helper.
   * This avoids the decorator signature error and handles 'this' binding correctly.
   */
  private retrievalTool = tool(
    async ({ query, topK }) => {
      const actualTopK = topK ?? this.topK;
      const results = await getRelatedDocumentsFn(this.hnsw, query, actualTopK);

      // LLMs expect the tool output to be a string
      return JSON.stringify(results);
    },
    {
      name: 'getRelatedDocuments',
      description: 'Searches the knowledge base for documents related to the query.',
      schema: z.object({
        query: z.string().describe('The search query to find relevant documents'),
        topK: z.number().optional().describe('Optional number of documents to retrieve'),
      }),
    },
  );

  async init() {
    if (!this.skipHnswInit) {
      await this.hnsw.init();
      await this.hnsw.open();
    }

    const model = new ChatAnthropic({
      modelName: this.modelName,
      temperature: 0,
    });

    this.agent = createAgent({
      model: model,
      tools: [this.retrievalTool],
      systemPrompt: SYSTEM_PROMPT,
      checkpointer: this.memory,
    }) as unknown as RagAgentRuntime;
  }

  async answer(prompt: string, conversationId?: string): Promise<RagAgentResponse> {
    if (!this.agent) throw new Error('Agent not initialized. Call init() first.');

    const config = { configurable: { thread_id: conversationId ?? String(threadId) } };

    const response = await this.agent.invoke({ messages: [{ role: 'user', content: prompt }] }, config);

    const lastAI = response.messages.filter((m) => m._getType() === 'ai').at(-1);
    const answer = typeof lastAI?.content === 'string' ? lastAI.content : '';

    const sourcesMap = new Map<string, string>(); // id → name
    for (const msg of response.messages) {
      if (msg._getType() === 'tool') {
        try {
          const results = JSON.parse(msg.content as string) as Array<{
            id: string;
            metadata?: { name?: string };
          }>;
          for (const r of results) {
            if (r.id && !sourcesMap.has(r.id)) {
              sourcesMap.set(r.id, r.metadata?.name ?? r.id);
            }
          }
        } catch {
          /* tool output wasn't JSON — skip */
        }
      }
    }

    return { answer, sources: [...sourcesMap.entries()].map(([id, name]) => ({ id, name })) };
  }
}
