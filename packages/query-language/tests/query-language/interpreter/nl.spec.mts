//@author Tijn Gommers
//@date 2026-04-02

import 'dotenv/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { NaturalLanguageExecutor } from '../../../src/interpreter/nl.mjs';
import { InMemoryStorageAdapter } from '../../../storage-adapter/in-memory-storage-adapter.mjs';
import type { QueryExecutionResult, SelectResult } from '../../../src/types/execution-results.mjs';

type OpenAIChatCompletionRequest = {
  model: string;
  temperature: number;
  messages: Array<{
    role: 'system' | 'user';
    content: string;
  }>;
};

function asSelectResult(result: QueryExecutionResult): SelectResult {
  if (result.type !== 'SelectResult') {
    throw new Error(`Expected SelectResult but got ${result.type}`);
  }

  return result;
}

describe('NaturalLanguageExecutor', () => {
  it('should call OpenAI and execute the returned SQL', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: 'SELECT NAME FROM USERS WHERE ACTIVE = 1',
            },
          },
        ],
      }),
    );

    const openAiClientMock = {
      chat: {
        completions: {
          create: createMock,
        },
      },
    };

    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, NAME: 'Alice', ACTIVE: 1 },
        { ID: 2, NAME: 'Bob', ACTIVE: 0 },
      ],
    });

    const executor = new NaturalLanguageExecutor({
      client: openAiClientMock,
      storageAdapter: adapter,
    });

    const result = await executor.executeNaturalLanguageQuery('show active users');
    const selectResult = asSelectResult(result);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(selectResult.rows).toHaveLength(1);
    expect(selectResult.rows).toEqual(expect.arrayContaining([expect.objectContaining({ NAME: 'Alice' })]));
  });

  it('should include schema context and allowed statements in the prompt', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: 'SELECT NAME FROM USERS',
            },
          },
        ],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      schemaContext: 'USERS(ID, NAME, ACTIVE)',
      allowedStatements: ['DELETE'],
    });

    await expect(executor.executeNaturalLanguageQuery('list users')).rejects.toThrow(
      'OpenAI response used an unsupported statement type: SELECT',
    );

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).toContain('Schema context:');
    expect(request.messages[0].content).toContain('USERS(ID, NAME, ACTIVE)');
    expect(request.messages[0].content).toContain('Allowed statements: DELETE');
  });

  it('should include language specification text in the prompt', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: 'SELECT NAME FROM USERS',
            },
          },
        ],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      languageSpecText: 'RULE: USE EXACT GRAMMAR',
    });

    await executor.executeNaturalLanguageQuery('list users');

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).toContain('Query language specification:');
    expect(request.messages[0].content).toContain('RULE: USE EXACT GRAMMAR');
  });

  it('should include language specification only in the first prompt by default', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: 'SELECT NAME FROM USERS',
            },
          },
        ],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      languageSpecText: 'RULE: FIRST PROMPT ONLY',
    });

    await executor.executeNaturalLanguageQuery('list users');
    await executor.executeNaturalLanguageQuery('list users again');

    const firstRequest = createMock.mock.calls[0]?.[0];
    const secondRequest = createMock.mock.calls[1]?.[0];

    if (!firstRequest || !secondRequest) {
      throw new Error('Expected two OpenAI requests to be captured');
    }

    expect(firstRequest.messages[0].content).toContain('Query language specification:');
    expect(firstRequest.messages[0].content).toContain('RULE: FIRST PROMPT ONLY');
    expect(secondRequest.messages[0].content).not.toContain('Query language specification:');
    expect(secondRequest.messages[0].content).not.toContain('RULE: FIRST PROMPT ONLY');
  });

  it('should reject multiple SQL statements before execution', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: 'SELECT NAME FROM USERS; DELETE FROM USERS',
            },
          },
        ],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
    });

    await expect(executor.executeNaturalLanguageQuery('show active users')).rejects.toThrow(
      'OpenAI response must contain exactly one SQL statement',
    );
  });

  it('should throw when no API key and no client are provided', () => {
    expect(() => new NaturalLanguageExecutor({ apiKey: '' })).toThrow('OPENAI_API_KEY is required');
  });

  it('should throw when OpenAI response has no SQL content', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: '   ' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
    });

    await expect(executor.executeNaturalLanguageQuery('show active users')).rejects.toThrow(
      'OpenAI response did not contain SQL text',
    );
  });

  it('should sanitize fenced SQL response before execution', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: '```sql\nsql: SELECT NAME FROM USERS WHERE ACTIVE = 1;\n```',
            },
          },
        ],
      }),
    );

    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, NAME: 'Alice', ACTIVE: 1 },
        { ID: 2, NAME: 'Bob', ACTIVE: 0 },
      ],
    });

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      storageAdapter: adapter,
    });

    const result = await executor.executeNaturalLanguageQuery('show active users');
    const selectResult = asSelectResult(result);

    expect(selectResult.rows).toHaveLength(1);
    expect(selectResult.rows).toEqual(expect.arrayContaining([expect.objectContaining({ NAME: 'Alice' })]));
  });

  it('should use a custom prompt builder with prompt context', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const promptBuilder = vi.fn((nlQuery: string) => ({
      systemPrompt: 'CUSTOM SYSTEM PROMPT',
      userPrompt: `CUSTOM USER: ${nlQuery}`,
    }));

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      promptBuilder,
      model: 'gpt-test-model',
      schemaContext: 'USERS(ID, NAME)',
      allowedStatements: ['SELECT'],
    });

    await executor.executeNaturalLanguageQuery('list all names');

    expect(promptBuilder).toHaveBeenCalledWith('list all names', {
      model: 'gpt-test-model',
      schemaContext: 'USERS(ID, NAME)',
      allowedStatements: ['SELECT'],
    });

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).toBe('CUSTOM SYSTEM PROMPT');
    expect(request.messages[1].content).toBe('CUSTOM USER: list all names');
  });

  it('should omit language specification when includeLanguageSpecInPrompt is false', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      includeLanguageSpecInPrompt: false,
      languageSpecText: 'DO NOT INCLUDE ME',
    });

    await executor.executeNaturalLanguageQuery('list users');

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).not.toContain('Query language specification:');
    expect(request.messages[0].content).not.toContain('DO NOT INCLUDE ME');
  });

  it('should include language specification in every prompt when includeLanguageSpecOnlyOnce is false', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      includeLanguageSpecOnlyOnce: false,
      languageSpecText: 'REPEATABLE SPEC',
    });

    await executor.executeNaturalLanguageQuery('list users');
    await executor.executeNaturalLanguageQuery('list users again');

    const firstRequest = createMock.mock.calls[0]?.[0];
    const secondRequest = createMock.mock.calls[1]?.[0];

    if (!firstRequest || !secondRequest) {
      throw new Error('Expected two OpenAI requests to be captured');
    }

    expect(firstRequest.messages[0].content).toContain('REPEATABLE SPEC');
    expect(secondRequest.messages[0].content).toContain('REPEATABLE SPEC');
  });

  it('should read language specification text from file path when text is not provided', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nl-spec-'));
    const specPath = join(tempDir, 'AI_QUERY_LANGUAGE_SPEC.md');
    writeFileSync(specPath, 'FILE SPEC CONTENT', 'utf8');

    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      languageSpecPath: specPath,
    });

    try {
      await executor.executeNaturalLanguageQuery('list users');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).toContain('Query language specification:');
    expect(request.messages[0].content).toContain('FILE SPEC CONTENT');
  });

  it('should skip language specification when the configured spec file is missing', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      languageSpecPath: join(tmpdir(), 'definitely-missing-spec-file.md'),
    });

    await executor.executeNaturalLanguageQuery('list users');

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).not.toContain('Query language specification:');
  });

  it('should skip language specification when the configured spec file is empty', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nl-empty-spec-'));
    const specPath = join(tempDir, 'AI_QUERY_LANGUAGE_SPEC.md');
    writeFileSync(specPath, '   \n\n', 'utf8');

    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      languageSpecPath: specPath,
    });

    try {
      await executor.executeNaturalLanguageQuery('list users');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const request = createMock.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('Expected OpenAI request to be captured');
    }

    expect(request.messages[0].content).not.toContain('Query language specification:');
  });

  it('should call validateSql with cleaned SQL output', async () => {
    const validateSql = vi.fn();
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: '```sql\nsql: SELECT NAME FROM USERS;\n```' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      validateSql,
    });

    await executor.executeNaturalLanguageQuery('list users');

    expect(validateSql).toHaveBeenCalledWith('SELECT NAME FROM USERS');
  });

  it('should surface validateSql failures', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
      validateSql: () => {
        throw new Error('Custom SQL validation failed');
      },
    });

    await expect(executor.executeNaturalLanguageQuery('list users')).rejects.toThrow('Custom SQL validation failed');
  });

  it('should throw when generated SQL cannot be parsed', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: [{ message: { content: 'SELECT FROM USERS' } }],
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
    });

    await expect(executor.executeNaturalLanguageQuery('broken query')).rejects.toThrow(
      'OpenAI response did not produce a valid query:',
    );
  });

  it('should throw when OpenAI response choices are missing', async () => {
    const createMock = vi.fn((_request: OpenAIChatCompletionRequest) =>
      Promise.resolve({
        choices: undefined,
      }),
    );

    const executor = new NaturalLanguageExecutor({
      client: {
        chat: {
          completions: {
            create: createMock,
          },
        },
      },
    });

    await expect(executor.executeNaturalLanguageQuery('show active users')).rejects.toThrow(
      'OpenAI response did not contain SQL text',
    );
  });

  it('should use the default fetch-backed client when only apiKey is provided', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'SELECT NAME FROM USERS' } }],
          }),
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const adapter = new InMemoryStorageAdapter({
      USERS: [{ NAME: 'Alice' }],
    });

    const executor = new NaturalLanguageExecutor({
      apiKey: 'test-key',
      storageAdapter: adapter,
      includeLanguageSpecInPrompt: false,
    });

    try {
      const result = await executor.executeNaturalLanguageQuery('list users');
      const selectResult = asSelectResult(result);

      expect(selectResult.rows).toEqual([{ NAME: 'Alice' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should propagate fetch error details from the default client', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
        json: () => Promise.resolve({}),
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const executor = new NaturalLanguageExecutor({
      apiKey: 'test-key',
      includeLanguageSpecInPrompt: false,
    });

    try {
      await expect(executor.executeNaturalLanguageQuery('list users')).rejects.toThrow(
        'OpenAI request failed: 401 unauthorized',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
