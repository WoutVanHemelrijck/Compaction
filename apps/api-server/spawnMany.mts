// @author Jari Daemen
// @date 2026-04-16

import { spawnDaemon } from './simpledbmsd.mjs';

/**
 * NOTE: daemons spawned this way all belong to the same `npx tsx spawnMany.mts` process. I.e., same PID.
 *
 * If you want separate PIDs to selectively kill and restart (which you should), use spawnOne.mts
 */

const nodeCount = 3;

const baseId = 'node';
const basePort = 3000;
if (nodeCount < 2) {
  throw new Error('node count must be a positive integer greater than 1!');
}

//
const nodes = [];
for (let i = 0; i < nodeCount; i++) {
  const node = { id: baseId + String(i + 1), address: `localhost:${basePort + i + 1}` };
  nodes.push(node);
}

for (const node of nodes) {
  console.log(node['address']);
  const port = Number(node['address'].substring(10));

  spawnDaemon(port, node['id'], nodes);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
