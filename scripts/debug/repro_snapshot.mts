import { spawnDaemon } from './src/simpledbmsd.mjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, './data');

async function cleanup() {
  try {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });
  } catch (e) {}
}

async function run() {
  await cleanup();

  const nodes = [
    { id: 'node1', port: 3001, grpc: 50001 },
    { id: 'node2', port: 3002, grpc: 50002 },
    { id: 'node3', port: 3003, grpc: 50003 },
  ];
  const wellKnownPeers = nodes.map((n) => ({ id: n.id, address: `localhost:${n.port}` }));

  console.log('Starting 3-node cluster...');
  process.env['NODE_ENV'] = 'development';

  // Spawn all nodes
  nodes.forEach((n) => {
    spawnDaemon(n.port, n.id, wellKnownPeers);
  });

  // Wait for leader election
  console.log('Waiting for leader election (10s)...');
  await new Promise((resolve) => setTimeout(resolve, 10000));

  // Try to find the leader
  let leaderPort = 3001;
  try {
    const leaderRes = await fetch(`http://localhost:3001/RAFT/getLeader`);
    const leaderData = await leaderRes.json();
    leaderPort = leaderData.leaderEndpoint;
    console.log(`Leader identified at port ${leaderPort}`);
  } catch (e) {
    console.log('Could not identify leader via node1, trying node1 directly for write.');
  }

  console.log('Inserting a document to trigger snapshot later...');
  // We send multiple inserts to ensure it applies and we trigger the DROPLOG logic
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`http://localhost:${leaderPort}/db/testcoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Doc ${i}`, content: 'Important data in heap' }),
    });
    const result = await response.json();
    console.log(`Insert ${i} result:`, result);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Wait for snapshot to be triggered and logged
  console.log('Waiting for snapshot trigger (5s)...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log('Checking file sizes on disk:');
  const files = await fs.readdir(dataDir);
  for (const file of files) {
    if (file.startsWith('wikipedia.')) {
      const stats = await fs.stat(path.join(dataDir, file));
      console.log(`${file}: ${stats.size} bytes`);
    }
  }

  console.log('Test finished. Check the console output for [daemonFSM] logs.');
  process.exit(0);
}

run().catch(console.error);
