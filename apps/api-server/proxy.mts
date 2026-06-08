import { Proxy } from 'axios-express-proxy';
import express from 'express';

const app = express();
app.use(express.json({ limit: '50mb' }));

const port = 4000;

const target = 3001; // Need to ask somebody who the leader is.

/**
 * For debugging purposes, nodes can still be accessed separately through their /debug/ endpoints.
 * curl -X 'GET'   http://localhost:3003/debug/1
 */

async function getLeaderEndpoint(): Promise<number> {
  const url = `http://localhost:${target}/RAFT/getLeader`;
  const response: Response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Response status: ${response.status}`);
  }
  const result = (await response.json()) as { leaderID: string; leaderEndpoint: number };
  return result['leaderEndpoint'];
}

function prepareRequest(req: express.Request): string {
  // Strip cache-validation headers to prevent 304 responses (axios throws on 304)
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  // Swap route params for query params so axios-express-proxy forwards the real query string
  const href = req.params['href'] as string;
  (req as express.Request & { params: Record<string, string> }).params = req.query as Record<string, string>;
  return href;
}

/**
 * Do not use the proxy for /debug/ functions. Only for API endpoints for the simple dbmsd.
 */
app.get('/proxy/:href(*)', async (req, res) => {
  try {
    const endpoint = await getLeaderEndpoint();
    if (!endpoint) {
      res.status(503).json({ error: 'No leader elected yet, try again shortly' });
      return;
    }
    const href = prepareRequest(req);
    console.log(`forwarding request to http://localhost:${endpoint}/${href}`);
    await Proxy(`http://localhost:${endpoint}/${href}`, req, res);
  } catch (err: unknown) {
    if (!res.headersSent) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status = axiosErr?.response?.status ?? 500;
      res.status(status).json(axiosErr?.response?.data ?? { error: 'Proxy error' });
    }
  }
});

app.post('/proxy/:href(*)', async (req, res) => {
  try {
    const endpoint = await getLeaderEndpoint();
    if (!endpoint) {
      res.status(503).json({ error: 'No leader elected yet, try again shortly' });
      return;
    }
    const href = prepareRequest(req);
    console.log(`forwarding request to http://localhost:${endpoint}/${href}`);
    await Proxy(`http://localhost:${endpoint}/${href}`, req, res);
  } catch (err: unknown) {
    if (!res.headersSent) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status = axiosErr?.response?.status ?? 500;
      res.status(status).json(axiosErr?.response?.data ?? { error: 'Proxy error' });
    }
  }
});

app.put('/proxy/:href(*)', async (req, res) => {
  try {
    const endpoint = await getLeaderEndpoint();
    if (!endpoint) {
      res.status(503).json({ error: 'No leader elected yet, try again shortly' });
      return;
    }
    const href = prepareRequest(req);
    console.log(`forwarding request to http://localhost:${endpoint}/${href}`);
    await Proxy(`http://localhost:${endpoint}/${href}`, req, res);
  } catch (err: unknown) {
    if (!res.headersSent) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status = axiosErr?.response?.status ?? 500;
      res.status(status).json(axiosErr?.response?.data ?? { error: 'Proxy error' });
    }
  }
});

app.delete('/proxy/:href(*)', async (req, res) => {
  try {
    const endpoint = await getLeaderEndpoint();
    if (!endpoint) {
      res.status(503).json({ error: 'No leader elected yet, try again shortly' });
      return;
    }
    const href = prepareRequest(req);
    console.log(`forwarding request to http://localhost:${endpoint}/${href}`);
    await Proxy(`http://localhost:${endpoint}/${href}`, req, res);
  } catch (err: unknown) {
    if (!res.headersSent) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status = axiosErr?.response?.status ?? 500;
      res.status(status).json(axiosErr?.response?.data ?? { error: 'Proxy error' });
    }
  }
});

/**
 * Start up the proxy server
 */
app.listen(port, () => {
  console.log(`Proxy server listening at http://localhost:${port}/`);
});
