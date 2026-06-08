// @author Jari Daemen
// @date 2026-05-11

import { spawnDaemon } from './simpledbmsd.mjs';

/*
This file is just s.t. nodes are separate processes, rather than all being bound to spawn.mts

If you have nodeCount = N, you can spawn:

npx tsx spawnOne.mts node1
npx tsx spawnOne.mts node2
...
npx tsx spawnOne.mts nodeN

*/
const nodeCount = 2;
const baseId = 'node';
const basePort = 3000;
if (nodeCount < 2) {
  throw new Error('node count must be a positive integer greater than 1!'); // RAFT doesn't handle having no peers at all, since RAFT would be useless anyway.
}
const nodes = [];
for (let i = 0; i < nodeCount; i++) {
  const node = { id: baseId + String(i + 1), address: `localhost:${basePort + i + 1}` };
  nodes.push(node);
}
//

// The node we're loading in now.
const nodeId = process.argv[2];
if (!nodeId) {
  throw new Error('node id must be provided');
}
const nodePort = Number(nodeId.substring(4));
const node = { id: nodeId, address: `localhost:${nodePort}` };
const port = 3000 + Number(node['address'].substring(10));

//
spawnDaemon(port, node['id'], nodes);
