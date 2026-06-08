// @author: Frederick Hillen
// @date: 2026-04-15

import 'dotenv/config';
import * as fs from 'node:fs';
import { SaxesParser } from 'saxes';
import { type Document } from '../core/simpledbms.mjs';

/**
 * To run the import script via proxy to RAFT cluster:
 *
 * Using npm script:
 * npm run wiki-import -- --daemon-url <proxyUrl> <userId> <wikipediaXmlFile>
 *
 * Example:
 * npm run wiki-import -- --daemon-url http://localhost:4000 <userId> <wikipediaXmlFile>
 *
 * run from /team09/
 * npm run wiki-import -- --daemon-url http://localhost:4000 e4d3a933-4928-4ad4-b480-f9598eeab5d7 ./src/big-data-import/wp.xml
 *
 *
 * The userId is a string that will be used to link the imported Wikipedia pages to a user.
 * The daemon-url should point to the proxy server (e.g., http://localhost:4000).
 */

interface Arguments {
  wikipediaFileName: string;
  userId: string;
  daemonUrl: string;
}

interface WikiPage extends Document {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  pageId: number;
  title: string;
  timestamp: number;
  content: string;
}

/**
 * Extracts the tag name from an XML node or tag name input, handling various types and edge cases.
 * @param {unknown} node
 * @returns {string}
 */
export function getTagName(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node !== 'object' || node === null) return '';
  const rawName = (node as Record<string, unknown>)['name'];
  if (typeof rawName === 'string') return rawName;
  if (typeof rawName === 'number' || typeof rawName === 'bigint' || typeof rawName === 'boolean') return `${rawName}`;
  return '';
}

/**
 * Runs the Wikipedia import process by sending batches through the proxy to RAFT cluster.
 * @param {Arguments} args - The command-line arguments.
 * @returns {Promise<void>} - A promise that resolves when the import process is complete.
 */
export async function runFromWikipedia(args: Arguments): Promise<void> {
  if (!args.daemonUrl) {
    throw new Error('--daemon-url is required for RAFT-backed import');
  }

  const proxyBase = args.daemonUrl.replace(/\/$/, '');
  const startTime = Date.now();
  console.log(`Starting Wikipedia import to ${proxyBase}...`);

  const FILE_PATH = args.wikipediaFileName;
  const BATCH_SIZE = 10;
  const MAX_CONTENT_SIZE = 500 * 1024; // 500 KB per document

  // create the collection wikipedia first
  const target = 3001;
  const raftURL = `http://localhost:${target}/RAFT/getLeader`;
  const response: Response = await fetch(raftURL);
  if (!response.ok) {
    throw new Error(`Response status: ${response.status}`);
  }
  const result: { leaderID: string; leaderEndpoint: number } = (await response.json()) as {
    leaderID: string;
    leaderEndpoint: number;
  };
  const endpoint: number = result['leaderEndpoint'];

  const url = `http://localhost:${endpoint}/db/wikipedia`;
  console.log(`forwarding request to ${url}`);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'wikipedia' }),
  });

  //

  async function processWikiDump(): Promise<number> {
    console.log('Starting XML stream parsing...');

    const readStream = fs.createReadStream(FILE_PATH, {
      encoding: 'utf8',
      highWaterMark: 1024 * 1024,
    });

    const parser = new SaxesParser({ xmlns: false });

    let batch: WikiPage[] = [];
    let totalProcessed = 0;
    let batchesSubmitted = 0;

    interface WikiPageBuilder {
      pageIdRaw: string;
      title: string;
      timestamp: string;
      content: string;
    }

    let currentItem: WikiPageBuilder | null = null;
    const tagStack: string[] = [];
    let currentPath = '';

    const appendText = (textChunk: string): void => {
      if (!currentItem) return;

      if (currentPath === 'mediawiki/page/title') {
        currentItem.title += textChunk;
      } else if (currentPath === 'mediawiki/page/id') {
        currentItem.pageIdRaw += textChunk;
      } else if (currentPath === 'mediawiki/page/revision/timestamp') {
        currentItem.timestamp += textChunk;
      } else if (currentPath === 'mediawiki/page/revision/text') {
        currentItem.content += textChunk;
      }
    };

    const flushBatch = async (force = false): Promise<void> => {
      if (!force && batch.length < BATCH_SIZE) return;
      if (batch.length === 0) return;

      //
      console.log();
      //
      const target = 3001;
      const raftURL = `http://localhost:${target}/RAFT/getLeader`;
      const response: Response = await fetch(raftURL);
      if (!response.ok) {
        throw new Error(`Response status: ${response.status}`);
      }
      const result: { leaderID: string; leaderEndpoint: number } = (await response.json()) as {
        leaderID: string;
        leaderEndpoint: number;
      };
      const endpoint: number = result['leaderEndpoint'];

      /**
       * Forward the API request to the leader
       */
      //const url = `${proxyBase}/proxy/db/wikipedia/wikipedia`;
      const url = `http://localhost:${endpoint}/db/wikipedia/wikipedia`;

      const records = batch;
      batch = [];

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        console.log(`forwarding request to ${url}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documents: records }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        batchesSubmitted++;
        totalProcessed += records.length;
        console.log(`Sent batch ${batchesSubmitted}: ${records.length} docs (total: ${totalProcessed})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to send batch to ${url}: ${msg}`);
        throw error instanceof Error ? error : new Error(String(error));
      }
    };

    parser.on('opentag', (node) => {
      const tagName = getTagName(node);
      tagStack.push(tagName);
      currentPath = tagStack.join('/');

      if (tagName === 'page') {
        currentItem = {
          pageIdRaw: '',
          title: '',
          timestamp: '',
          content: '',
        };
      }
    });

    parser.on('text', appendText);
    parser.on('cdata', appendText);

    parser.on('closetag', (tag) => {
      const normalizedTagName = getTagName(tag);
      if (normalizedTagName === 'page' && currentItem) {
        const parsedId = Number.parseInt(currentItem.pageIdRaw.trim(), 10);
        const parsedTimestamp = Date.parse(currentItem.timestamp.trim());
        if (!Number.isNaN(parsedId) && Number.isFinite(parsedTimestamp)) {
          const title = currentItem.title.trim();
          let content = currentItem.content.trim();

          // Truncate content if it exceeds max size
          if (content.length > MAX_CONTENT_SIZE) {
            console.log(`Truncating content for page "${title}" from ${content.length} to ${MAX_CONTENT_SIZE} bytes`);
            content = content.substring(0, MAX_CONTENT_SIZE);
          }

          const id = String(parsedId);

          const docToInsert = {
            id,
            name: title,
            userId: args.userId,
            createdAt: new Date(parsedTimestamp).toISOString(),
            pageId: parsedId,
            title,
            timestamp: parsedTimestamp,
            content,
          };

          batch.push(docToInsert);
        }

        currentItem = null;
      }

      tagStack.pop();
      currentPath = tagStack.length ? tagStack.join('/') : '';
    });

    parser.on('error', (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    });

    try {
      for await (const chunk of readStream as AsyncIterable<string>) {
        parser.write(chunk);
        await flushBatch(false);
      }

      parser.close();
      await flushBatch(true);
      console.log(`\nFinished parsing! Processed and sent ${totalProcessed} pages in ${batchesSubmitted} batches.`);
    } finally {
      readStream.destroy();
    }

    return totalProcessed;
  }

  const totalDocs = await processWikiDump();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nImport complete in ${duration}s: ${totalDocs} documents imported`);
}

/**
 * Parses the command-line arguments for the Wikipedia import script.
 * @param {string[]} argv - The command-line arguments.
 * @returns {Arguments} - The parsed arguments.
 */
export function parseCommand(argv: string[]): Arguments {
  const tokens = argv.slice(2);
  const positionals: string[] = [];
  const optionTokens = new Set(['--daemon-url', '-h', '--help']);

  let daemonUrl: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '--daemon-url') {
      const value = tokens[i + 1];
      if (value === undefined || value.trim() === '' || optionTokens.has(value)) {
        throw new Error('Missing value for --daemon-url');
      }
      daemonUrl = value;
      i++;
      continue;
    }

    if (token === '-h' || token === '--help') {
      throw new Error(
        'Usage: tsx src/big-data-import/wiki-import.mts --daemon-url <proxyUrl> <userId> <wikipediaXmlFile>',
      );
    }

    positionals.push(token);
  }

  if (positionals.length !== 2) {
    throw new Error(
      'Usage: tsx src/big-data-import/wiki-import.mts --daemon-url <proxyUrl> <userId> <wikipediaXmlFile>',
    );
  }

  if (!daemonUrl) {
    throw new Error('--daemon-url is required');
  }

  return {
    userId: positionals[0],
    wikipediaFileName: positionals[1],
    daemonUrl,
  } as Arguments;
}

if (process.env['VITEST'] === undefined) {
  try {
    await runFromWikipedia(parseCommand(process.argv));
  } catch (e) {
    if (e instanceof Error) {
      console.error(e.stack ?? e.message);
    } else {
      console.error(e);
    }
    process.exit(1);
  }
}
