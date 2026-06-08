# Voorbeeld voor reference: de insertMany flow

### ENDPOINT

```
app.post('/db/:collection/insertMany', async (req, res) => {
    try {
      const name: string | undefined = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }
      const body = req.body as { documents?: unknown[] };
      const documents = body['documents'] as Document[];

      if (!documents || !Array.isArray(documents)) {
        res.status(400).json({ error: 'documents array is required' });
        return;
      }

      if (documents.length === 0) {
        res.status(400).json({ error: 'documents array must not be empty' });
        return;
      }

      // Add UUIDs here (leader) for proper RAFT replication
      documents.forEach((doc) => (doc['id'] = randomUUID()));

      //
      if (!node) {
        throw Error('node was null or undefined - (INSERT MANY)');
      }
      await node!.submitCommand({ type: 'CREATE', payload: { name: name, documents: documents } });

      //
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
```

### HIGH-LEVEL FLOW
1. start proxy met `npx tsx proxy.mts` in terminal 1.
2. start `spawnMany.mts` in terminal 2.
3. stuur een curl `X` naar de proxy op `localhost:4000/proxy/X`. De proxy forward request `X` naar de leader.

e.g. 
```
curl -X 'POST' \
  'http://localhost:4000/proxy/db/A/insertMany' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
  "documents": [
    {
      "name": "John Doe",
      "age": 25,
      "isActive": true
    },
    {
      "name": "Jane Smith",
      "age": 30,
      "isActive": false
    }
  ]
}'
```

# VOORSTEL WIKIPEDIA IMPORT

Stel je hebt 50k documenten. Maak een exacte kopie van endpoint `/insertMany/` en stuur die docs naar daar in *reasonable sized* batches (wat dat ook mag wezen).

```
app.post('/db/:collection/wikipedia', async (req, res) => {
    try {
      const name: string | undefined = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }
      const body = req.body as { documents?: unknown[] };
      const documents = body['documents'] as Document[];

      if (!documents || !Array.isArray(documents)) {
        res.status(400).json({ error: 'documents array is required' });
        return;
      }

      if (documents.length === 0) {
        res.status(400).json({ error: 'documents array must not be empty' });
        return;
      }

      // Add UUIDs here (leader) for proper RAFT replication
      documents.forEach((doc) => (doc['id'] = randomUUID()));

      //
      if (!node) {
        throw Error('node was null or undefined - (INSERT MANY)');
      }
      await node!.submitCommand({ type: 'CREATE', payload: { name: name, documents: documents, force: true } });

      //
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
```

Die `force: true` zorgt dat de commands niet gebuffered worden, maar direct worden uitgevoerd op alle RAFT nodes. Normaal gezien regelt RAFT de rest. 

Om uw 50k docs op te delen in e.g. batches van 1k docs, call de proxy 50k/1k = 50 keer in een loop met 1k docs elk.