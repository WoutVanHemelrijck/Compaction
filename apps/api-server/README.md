# Server (`src/server/`)

HTTP REST API server for SimpleDBMS, with authentication, Swagger documentation, and cluster support.

## Contents

- **`simpledbmsd.mts`** - Main Express server
- **`simpledbmsd.spec.mts`** - Server tests
- **`proxy.mts`** - Request proxy utilities
- **`application.mts`** - Application harness
- **`spawnOne.mts`**, **`spawnMany.mts`** - Cluster utilities

## Quick Start

```bash
npm run dev
# Starts server on http://localhost:3000
```

## API Endpoints

### Authentication

```http
POST /api/signup
Body: { username: "user", password: "pass" }
→ { token: "eyJhbGc..." }

POST /api/login
Body: { username: "user", password: "pass" }
→ { token: "eyJhbGc..." }
```

### Collections (REST-style)

```http
GET /db
→ { collections: ["users", "products"] }

POST /api/createCollection
Body: { name: "users" }
→ { success: true, name: "users" }

DELETE /api/deleteCollection
Body: { name: "users" }
→ { success: true }

GET /db/:collection/indexes
→ { indexes: [{name: "...", fields: [...]}] }
```

### Documents

```http
POST /db/:collection
Body: { name: "Alice", age: 30 }
→ { id: "uuid-..." }

GET /db/:collection
→ { documents: [...], count: 5 }

GET /db/:collection/:id
→ { id: "uuid-...", name: "Alice", age: 30 }

PUT /db/:collection/:id
Body: { name: "Alicia", age: 31 }
→ { success: true }

DELETE /db/:collection/:id
→ { success: true }

POST /db/:collection/insertMany
Body: { documents: [{name: "Bob"}, {name: "Charlie"}] }
→ { count: 2 }
```

### Queries

```http
POST /api/query/sql
Body: { sql: "SELECT * FROM users WHERE age > 25" }
→ { results: [...] }

POST /api/query/natural-language
Body: { text: "Find users older than 25" }
→ { results: [...] }
```

### Database Operations

```http
POST /db/compact
→ { success: true }

POST /db/shrink
→ { success: true }

GET /api/getAllUserData
→ { data: {...} }
```

## Authentication

Most endpoints require JWT token. Obtain token via signup or login, then include in subsequent requests:

```http
Authorization: Bearer <token>
```

Public endpoints that don't require auth:

- GET `/` (homepage)
- POST `/api/signup`
- POST `/api/login`

## Swagger Documentation

Access interactive API docs:

```
http://localhost:3000/api-docs
```

## Environment Variables

```bash
# Server
PORT=3000
HOST=localhost

# Authentication
JWT_SECRET=your-secret-key
JWT_EXPIRATION=30m

# Database
DB_PATH=mydb.db
COMPRESSION_ALGORITHM=zstd
AUTO_COMPACTION_THRESHOLD=50

# Clustering
RAFT_NODE_ID=1
RAFT_PEERS=localhost:5001,localhost:5002
```

## Clustering with Raft

### Multi-Node Setup

```bash
# Node 1 (leader candidate)
RAFT_NODE_ID=1 \
RAFT_PEERS=localhost:5001,localhost:5002,localhost:5003 \
npm run dev

# Node 2 (follower)
RAFT_NODE_ID=2 \
RAFT_PEERS=localhost:5001,localhost:5002,localhost:5003 \
PORT=3001 \
npm run dev

# Node 3 (follower)
RAFT_NODE_ID=3 \
RAFT_PEERS=localhost:5001,localhost:5002,localhost:5003 \
PORT=3002 \
npm run dev
```

### Features

- **Leader Election**: Automatic failover
- **Log Replication**: All writes replicated to followers
- **Consensus**: Write committed after majority acks
- **Fault Tolerance**: Tolerates up to (N-1)/2 failures

## Error Handling

All errors return JSON with status code:

```json
{
  "success": false,
  "error": "Collection 'users' not found",
  "code": "COLLECTION_NOT_FOUND"
}
```

### Common Status Codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 200  | Success                              |
| 400  | Bad request (invalid parameters)     |
| 401  | Unauthorized (missing token)         |
| 403  | Forbidden (insufficient permissions) |
| 404  | Not found (resource doesn't exist)   |
| 500  | Server error                         |

## Testing

```bash
# Run server tests
npm test -- src/server/simpledbmsd.spec.mts

# Integration tests (requires running server)
curl http://localhost:3000/api/health

# Load test
npm run bench:server  # (if implemented)
```

## Performance Tuning

1. **Connection pooling** - Reuse connections
2. **Compression** - Enable payload compression
3. **Caching** - Cache frequent queries
4. **Batch operations** - Batch inserts/updates
5. **Clustering** - Load balance across nodes

## Security Considerations

1. **Authentication** - JWT tokens required
2. **HTTPS** - Use TLS in production
3. **SQL Injection** - Parameterized queries (built-in)
4. **Rate Limiting** - Consider adding for public APIs
5. **Input Validation** - All inputs validated

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
EXPOSE 3000
CMD ["npm", "run", "dev"]
```

```bash
docker build -t simpledbms .
docker run -p 3000:3000 -v $(pwd)/data:/app/data simpledbms
```

### systemd Service

```ini
[Unit]
Description=SimpleDBMS Server
After=network.target

[Service]
Type=simple
User=dbms
WorkingDirectory=/opt/simpledbms
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Monitoring

### Logs

```bash
# Enable debug logging
DEBUG=simpledbms:* npm run dev

# Tail logs
tail -f logs/simpledbms.log
```

### Metrics

```bash
# Via /api/stats endpoint
curl http://localhost:3000/api/stats | jq .

# Response:
{
  "collections": {"users": {"docCount": 1000}},
  "totalSize": 5242880,
  "indexCount": 3,
  "timestamp": "2025-05-14T10:00:00Z"
}
```

## References

- [Core Module](../core/README.md) - Database engine
- [Authentication](../auth/README.md) - JWT implementation
- [Full Architecture](../../docs/ARCHITECTURE.md)
