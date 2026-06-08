# Frontend

React + Vite SPA. Communicates with the Express backend via a Vite proxy — the backend must be running before you start the dev server.

---

## Requirements

**Node.js v22+** is required. Node 20 will fail at startup with:

```
SyntaxError: The requested module 'node:zlib' does not provide an export named 'zstdCompressSync's
```

This is because the backend uses zstd compression, which was only added to Node's built-in `zlib` module in v21.7.0.

Upgrade with nvm:

```bash
nvm install 22
nvm use 22
```

Or set a default so it persists across terminals:

```bash
nvm alias default 22
```

---

## Setup

Install dependencies from the **repo root** (not the frontend/ folder):

```bash
npm install
```

---

## Running

Two terminals are needed — one for the backend, one for the frontend.

**Terminal 1 — backend:**

```bash
npm run dev
```

Starts the Express server on http://localhost:3000. Keep this running.

**Terminal 2 — frontend dev server:**

```bash
npm run frontend:dev
```

Opens the app at **http://localhost:5173**. All `/api/*` and `/db/*` requests are proxied to the backend automatically.

---

## Resetting the database

If you hit login issues or want a clean slate:

```bash
npm run reset-db
npm run dev   # restart the backend after reset
```

---

## Production build

```bash
npm run frontend:build
```

Output is written to `frontend-dist/` at the repo root, served by nginx in Docker.

---

## Environment variables

The frontend needs no environment variables. The backend reads from a `.env` file in the repo root:

| Variable         | Purpose                 | Default                  |
| ---------------- | ----------------------- | ------------------------ |
| `PORT`           | Backend port            | 3000                     |
| `ENCRYPTION_KEY` | Database encryption key | Auto-generated if absent |

`ENCRYPTION_KEY` must be a **64-character hex string** (32 bytes / 256 bits). If it's missing or changes between restarts, the server will fail to decrypt existing data with:

```
Decryption failed: Unsupported state or unable to authenticate data
```

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `.env` and never change it — or reset the DB if you do:

```bash
npm run reset-db
```
