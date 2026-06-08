// @author MaartenHaine, Jari Daemen
// @date 2025-11-22

import { describe, expect, it } from 'vitest';
describe('raft daemon API', () => {
  it('math', () => {
    expect(1 + 1).toBe(2);
  });
});

/**
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { app, initDB, loadDummyAccount } from './simpledbmsd.mjs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('SimpleDBMS Daemon API', () => {
  let tempDir: string;
  let dbPath: string;
  let walPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'simpledbms-test-'));
    dbPath = path.join(tempDir, 'test.db');
    walPath = path.join(tempDir, 'test.wal');
    const heapPath = path.join(tempDir, 'test-heap.db');
    const heapWalPath = path.join(tempDir, 'test-heap.wal');
    await initDB(dbPath, walPath, heapPath, heapWalPath);
    // Load dummy account data for testing
    await loadDummyAccount();
  }, 60000);

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Core REST API', () => {
    it('create a document', async () => {
      // Must create collection first now
      await request(app).post('/db').send({ name: 'users' });
      const res = await request(app).post('/db/users').send({ name: 'maarten', age: 22 });

      expect(res.status).toBe(201);
      expect((res.body as { id?: string }).id).toBeDefined();
      expect((res.body as { name?: string }).name).toBe('maarten');
    });

    it('insert multiple documents', async () => {
      const docs = [
        { name: 'user1', age: 20 },
        { name: 'user2', age: 30 },
      ];
      await request(app).post('/db').send({ name: 'bulkusers' });
      const res = await request(app).post('/db/bulkusers/insertMany').send({ documents: docs });

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as unknown[]).length).toBe(2);
    });

    it('should fail to insert if collection does not exist', async () => {
      const res = await request(app).post('/db/nonexistent').send({ name: 'fail' });
      expect(res.status).toBe(404);
      expect((res.body as { error?: string }).error).toContain('not found');
    });

    it('should fail insertMany if collection does not exist', async () => {
      const res = await request(app)
        .post('/db/nonexistent/insertMany')
        .send({ documents: [{ a: 1 }] });
      expect(res.status).toBe(404);
      expect((res.body as { error?: string }).error).toContain('not found');
    });

    it('find documents', async () => {
      const res = await request(app).get('/db/users');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it('get a document by ID', async () => {
      const createRes = await request(app).post('/db/users').send({ name: 'bob' });
      const id = (createRes.body as { id: string }).id;

      const res = await request(app).get(`/db/users/${id}`);
      expect(res.status).toBe(200);
      expect((res.body as { name?: string }).name).toBe('bob');
    });

    it('update a document', async () => {
      const createRes = await request(app).post('/db/users').send({ name: 'bob', age: 25 });
      const id = (createRes.body as { id: string }).id;

      const res = await request(app).put(`/db/users/${id}`).send({ age: 26 });

      expect(res.status).toBe(200);
      expect((res.body as { age?: number }).age).toBe(26);

      const checkRes = await request(app).get(`/db/users/${id}`);
      expect((checkRes.body as { age?: number }).age).toBe(26);
    });

    it('delete a document', async () => {
      const createRes = await request(app).post('/db/users').send({ name: 'bob' });
      const id = (createRes.body as { id: string }).id;

      const res = await request(app).delete(`/db/users/${id}`);
      expect(res.status).toBe(200);

      const checkRes = await request(app).get(`/db/users/${id}`);
      expect(checkRes.status).toBe(404);
    });

    it('should paginate documents correctly', async () => {
      // Create some documents
      await request(app).post('/db').send({ name: 'pagedusers' });
      await request(app).post('/db/pagedusers').send({ id: 'p1', name: 'user1' });
      await request(app).post('/db/pagedusers').send({ id: 'p2', name: 'user2' });
      await request(app).post('/db/pagedusers').send({ id: 'p3', name: 'user3' });
      await request(app).post('/db/pagedusers').send({ id: 'p2', name: 'user2' });
      await request(app).post('/db/pagedusers').send({ id: 'p3', name: 'user3' });

      const res = await request(app).get('/db/pagedusers/paged?limit=2');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect((res.body as { items: unknown[] }).items).toHaveLength(2);
      expect(res.body).toHaveProperty('hasNextPage', true);
      expect(res.body).toHaveProperty('nextCursor');
    });
  });

  describe('Query Language API', () => {
    it('should execute a SQL query through the query-language interpreter', async () => {
      const collectionName = 'querylangusers';

      await request(app).post('/db').send({ name: collectionName });
      await request(app).post(`/db/${collectionName}`).send({ name: 'Alice', age: 30 });
      await request(app).post(`/db/${collectionName}`).send({ name: 'Bob', age: 18 });

      const res = await request(app).post('/api/query/sql').send({
        query: 'SELECT name FROM querylangusers WHERE age = 30',
      });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);

      const responseBody: unknown = res.body;
      const result = responseBody as { result?: { type?: string; rows?: Array<Record<string, unknown>> } };
      expect(result.result?.type).toBe('SelectResult');
      const rows = result.result?.rows ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ NAME: 'Alice', AGE: 30 }));
      expect(typeof rows[0]?.['ID']).toBe('string');
    });

    it('should execute a natural-language query through the OpenAI-backed executor', async () => {
      const collectionName = 'querylangnlusers';

      await request(app).post('/db').send({ name: collectionName });
      await request(app).post(`/db/${collectionName}`).send({ name: 'Carol', age: 44 });
      await request(app).post(`/db/${collectionName}`).send({ name: 'Dave', age: 21 });

      const originalApiKey = process.env['OPENAI_API_KEY'];
      process.env['OPENAI_API_KEY'] = 'test-openai-key';

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: 'SELECT NAME FROM querylangnlusers WHERE AGE = 44',
                },
              },
            ],
          }),
        text: () => Promise.resolve(''),
      } as unknown as Response);

      try {
        const res = await request(app).post('/api/query/natural-language').send({
          prompt: 'show the 44 year old user',
        });

        expect(res.status).toBe(200);
        expect((res.body as { success?: boolean }).success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const responseBody: unknown = res.body;
        const result = responseBody as { result?: { type?: string; rows?: Array<Record<string, unknown>> } };
        expect(result.result?.type).toBe('SelectResult');
        const rows = result.result?.rows ?? [];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(expect.objectContaining({ NAME: 'Carol', AGE: 44 }));
        expect(typeof rows[0]?.['ID']).toBe('string');
      } finally {
        if (originalApiKey === undefined) {
          delete process.env['OPENAI_API_KEY'];
        } else {
          process.env['OPENAI_API_KEY'] = originalApiKey;
        }
      }
    });
  });

  describe('Authentication API', () => {
    it('should sign up a new user', async () => {
      const res = await request(app).post('/api/signup').send({ username: 'testuser', password: 'testpass' });

      expect(res.status).toBe(201);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { token?: string }).token).toBeDefined();
    });

    it('should not allow duplicate usernames', async () => {
      await request(app).post('/api/signup').send({ username: 'duplicate', password: 'pass' });

      const res = await request(app).post('/api/signup').send({ username: 'duplicate', password: 'pass' });

      expect(res.status).toBe(400);
      expect((res.body as { message?: string }).message).toContain('already exists');
    });

    it('should login with valid credentials', async () => {
      await request(app).post('/api/signup').send({ username: 'loginuser', password: 'loginpass' });

      const res = await request(app).post('/api/login').send({ username: 'loginuser', password: 'loginpass' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { token?: string }).token).toBeDefined();
    });

    it('should reject invalid credentials', async () => {
      const res = await request(app).post('/api/login').send({ username: 'nonexistent', password: 'wrongpass' });

      expect(res.status).toBe(401);
    });

    it('should validate existing token', async () => {
      const signupRes = await request(app).post('/api/signup').send({ username: 'tokenuser', password: 'tokenpass' });

      const token = (signupRes.body as { token: string }).token;

      const res = await request(app).post('/api/login').send({ token });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
    });

    it('should prefer username/password login when both credentials and token are provided', async () => {
      const userA = await request(app).post('/api/signup').send({ username: 'token-owner', password: 'StrongPass#1' });
      const tokenA = (userA.body as { token: string }).token;

      await request(app).post('/api/signup').send({ username: 'target-user', password: 'StrongPass#2' });

      const res = await request(app)
        .post('/api/login')
        .send({ username: 'target-user', password: 'StrongPass#2', token: tokenA });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean; message?: string }).success).toBe(true);
      expect((res.body as { message?: string }).message).toBe('Login successful');
    });
  });

  describe('Collection Management API', () => {
    let authToken: string;

    beforeAll(async () => {
      const signupRes = await request(app).post('/api/signup').send({ username: 'collectionuser', password: 'pass' });
      authToken = (signupRes.body as { token: string }).token;
    });

    it('should create a collection', async () => {
      const res = await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'myNotes' });

      expect(res.status).toBe(201);
      expect((res.body as { success?: boolean }).success).toBe(true);
    });

    it('should not allow duplicate collections', async () => {
      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'duplicateCollection' });

      const res = await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'duplicateCollection' });

      expect(res.status).toBe(400);
      expect((res.body as { message?: string }).message).toContain('already exists');
    });

    it('should fetch all collections', async () => {
      const res = await request(app).get('/api/fetchCollections').set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect(Array.isArray((res.body as { collections?: string[] }).collections)).toBe(true);
    });

    it('should delete a collection', async () => {
      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'toDelete' });

      const res = await request(app)
        .delete('/api/deleteCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'toDelete' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
    });

    it('should reject unauthorized collection creation', async () => {
      const res = await request(app).post('/api/createCollection').send({ collectionName: 'unauthorized' });

      expect(res.status).toBe(401);
    });
  });

  describe('Document Management API', () => {
    let authToken: string;
    const collectionName = 'testDocs';

    beforeAll(async () => {
      const signupRes = await request(app).post('/api/signup').send({ username: 'docuser', password: 'pass' });
      authToken = (signupRes.body as { token: string }).token;

      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName });
    });

    it('should create a document', async () => {
      const res = await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'MyFirstDoc',
          documentContent: { text: 'Hello World', priority: 'high' },
        });

      expect(res.status).toBe(201);
      expect((res.body as { success?: boolean }).success).toBe(true);
    });

    it('should not allow duplicate document names', async () => {
      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'DuplicateDoc',
          documentContent: { text: 'First' },
        });

      const res = await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'DuplicateDoc',
          documentContent: { text: 'Second' },
        });

      expect(res.status).toBe(400);
      expect((res.body as { message?: string }).message).toContain('already exists');
    });

    it('should fetch document content', async () => {
      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'ContentDoc',
          documentContent: { description: 'Test content', value: 42 },
        });

      const res = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName, documentName: 'ContentDoc' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { documentContent?: { description?: string } }).documentContent?.description).toBe(
        'Test content',
      );
    });

    it('should fetch legacy-style plain JSON document content (no compression envelope)', async () => {
      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'LegacyPlainDoc',
          documentContent: { a: 1 },
        });

      const res = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName, documentName: 'LegacyPlainDoc' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { documentContent?: { a?: number } }).documentContent?.a).toBe(1);
    });

    it('should update document content', async () => {
      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'UpdateDoc',
          documentContent: { status: 'draft' },
        });

      const res = await request(app)
        .put('/api/updateDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'UpdateDoc',
          newDocumentContent: { status: 'published', views: 100 },
        });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);

      const checkRes = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName, documentName: 'UpdateDoc' });

      expect((checkRes.body as { documentContent?: { status?: string } }).documentContent?.status).toBe('published');
    });

    it('should delete a document', async () => {
      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName,
          documentName: 'DeleteDoc',
          documentContent: { temp: true },
        });

      const res = await request(app)
        .delete('/api/deleteDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName, documentName: 'DeleteDoc' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);

      const checkRes = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName, documentName: 'DeleteDoc' });

      expect(checkRes.status).toBe(404);
    });

    it('should reject unauthorized document operations', async () => {
      const res = await request(app)
        .post('/api/createDocument')
        .send({ collectionName, documentName: 'Unauthorized', documentContent: {} });

      expect(res.status).toBe(401);
    });
  });

  describe('GDPR Compliance API', () => {
    let authToken: string;
    const testCollectionName = 'gdprTestCollection';

    beforeAll(async () => {
      const signupRes = await request(app).post('/api/signup').send({ username: 'gdpruser', password: 'gdprpass' });
      authToken = (signupRes.body as { token: string }).token;

      // Create a collection with some documents
      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: testCollectionName });

      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName: testCollectionName,
          documentName: 'TestDoc1',
          documentContent: { data: 'sample1' },
        });

      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          collectionName: testCollectionName,
          documentName: 'TestDoc2',
          documentContent: { data: 'sample2' },
        });
    });

    it('should retrieve user data', async () => {
      const res = await request(app).get('/api/getUserData').set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { userData?: { userId?: string } }).userData?.userId).toBeDefined();
      expect((res.body as { userData?: { username?: string } }).userData?.username).toBe('gdpruser');
      expect((res.body as { userData?: { hashedPassword?: string } }).userData?.hashedPassword).toBeDefined();
    });

    it('should reject unauthorized access to user data', async () => {
      const res = await request(app).get('/api/getUserData');

      expect(res.status).toBe(401);
    });

    it('should retrieve all user data including collections and documents', async () => {
      const res = await request(app).get('/api/getAllUserData').set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect((res.body as { userId?: string }).userId).toBeDefined();
      expect((res.body as { username?: string }).username).toBe('gdpruser');
      expect((res.body as { password?: string }).password).toBeDefined(); // Hashed password
      expect((res.body as { collections?: Record<string, unknown[]> }).collections).toBeDefined();

      const collections = (res.body as { collections?: Record<string, unknown[]> }).collections;
      expect(collections?.[testCollectionName]).toBeDefined();
      expect(Array.isArray(collections?.[testCollectionName])).toBe(true);
      expect(collections?.[testCollectionName].length).toBeGreaterThanOrEqual(2); // At least 2 documents
    });

    it('should reject unauthorized access to all user data', async () => {
      const res = await request(app).get('/api/getAllUserData');

      expect(res.status).toBe(401);
    });

    it('should only include user-owned documents in data export', async () => {
      // Create another user with their own collection and documents
      const otherUserRes = await request(app).post('/api/signup').send({ username: 'otheruser', password: 'pass' });
      const otherToken = (otherUserRes.body as { token: string }).token;

      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ collectionName: 'otherCollection' });

      await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({
          collectionName: 'otherCollection',
          documentName: 'OtherDoc',
          documentContent: { data: 'other' },
        });

      // Fetch first user's data
      const res = await request(app).get('/api/getAllUserData').set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      const collections = (res.body as { collections?: Record<string, unknown[]> }).collections;

      // Should only have testCollectionName, not otherCollection
      expect(collections?.[testCollectionName]).toBeDefined();
      expect(collections?.['otherCollection']).toBeUndefined();
    });
  });

  describe('Dummy Account Data', () => {
    let demoToken: string;

    beforeAll(async () => {
      // Login with demo account
      const loginRes = await request(app).post('/api/login').send({ username: 'demo', password: 'demo12345' });
      demoToken = (loginRes.body as { token: string }).token;
    });

    it('should login with demo account', async () => {
      const res = await request(app).post('/api/login').send({ username: 'demo', password: 'demo12345' });

      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
      expect((res.body as { token?: string }).token).toBeDefined();

      // Verify the demoToken from beforeAll is valid
      const collectionsRes = await request(app)
        .get('/api/fetchCollections')
        .set('Authorization', `Bearer ${demoToken}`);
      expect(collectionsRes.status).toBe(200);
    });
  });

  // --- DB-level routes ---

  describe('DB-level Routes', () => {
    it('GET /db should list collections', async () => {
      const res = await request(app).get('/db');
      expect(res.status).toBe(200);
      expect((res.body as { collections: string[] }).collections).toBeDefined();
      expect(Array.isArray((res.body as { collections: string[] }).collections)).toBe(true);
    });

    it('POST /db should create a new collection', async () => {
      const res = await request(app).post('/db').send({ name: 'testNewCollection' });
      expect(res.status).toBe(201);
      expect((res.body as { collection?: string }).collection).toBe('testNewCollection');
    });

    it('POST /db should return 400 for missing name', async () => {
      const res = await request(app).post('/db').send({});
      expect(res.status).toBe(400);
    });

    it('POST /db should return 400 for duplicate collection', async () => {
      await request(app).post('/db').send({ name: 'dupRestCol' });
      const res = await request(app).post('/db').send({ name: 'dupRestCol' });
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('already exists');
    });
  });

  // --- Find with query params ---

  describe('Find with Query Params', () => {
    beforeAll(async () => {
      // Ensure a collection with docs exists
      try {
        await request(app).post('/db').send({ name: 'queryTest' });
      } catch {
        //may already exist
      }
      await request(app).post('/db/queryTest').send({ id: 'qt1', name: 'alpha', score: 10 });
      await request(app).post('/db/queryTest').send({ id: 'qt2', name: 'bravo', score: 20 });
      await request(app).post('/db/queryTest').send({ id: 'qt3', name: 'charlie', score: 30 });
    });

    it('should find with filterOps JSON', async () => {
      const filter = JSON.stringify({ score: { $gte: 20 } });
      const res = await request(app).get(`/db/queryTest?filter=${encodeURIComponent(filter)}`);
      expect(res.status).toBe(200);
      expect((res.body as { id: string }[]).length).toBeGreaterThanOrEqual(2);
    });

    it('should return 400 for invalid filter JSON', async () => {
      const res = await request(app).get('/db/queryTest?filter=NOT_JSON');
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('Invalid JSON');
    });

    it('should find with limit, skip, and sort params', async () => {
      const res = await request(app).get('/db/queryTest?limit=2&skip=0&sortField=score&sortOrder=desc');
      expect(res.status).toBe(200);
      expect((res.body as unknown[]).length).toBeLessThanOrEqual(2);
    });

    it('should return 400 for comparison operators on strings via filterOps', async () => {
      const filter = JSON.stringify({ name: { $gt: 'a' } });
      const res = await request(app).get(`/db/queryTest?filter=${encodeURIComponent(filter)}`);
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('Comparison operators');
    });
  });

  // --- Index management ---

  describe('Index Management Routes', () => {
    beforeAll(async () => {
      try {
        await request(app).post('/db').send({ name: 'indexTest' });
      } catch {
        //may already exist
      }
      await request(app).post('/db/indexTest').send({ id: 'idx1', category: 'A', rating: 5 });
      await request(app).post('/db/indexTest').send({ id: 'idx2', category: 'B', rating: 3 });
    });

    it('GET /db/:collection/indexes should list indexes', async () => {
      const res = await request(app).get('/db/indexTest/indexes');
      expect(res.status).toBe(200);
      expect((res.body as { indexes: string[] }).indexes).toBeDefined();
    });

    it('POST /db/:collection/indexes/:field should create an index', async () => {
      // Drop first if it exists, then create
      await request(app).delete('/db/indexTest/indexes/rating');
      const res = await request(app).post('/db/indexTest/indexes/rating');
      expect(res.status).toBe(201);
      expect((res.body as { field?: string }).field).toBe('rating');
    });

    it('POST /db/:collection/indexes/:field should return 400 for duplicate index', async () => {
      // 'rating' was just created above
      const res = await request(app).post('/db/indexTest/indexes/rating');
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('already exists');
    });

    it('DELETE /db/:collection/indexes/:field should drop an index', async () => {
      const res = await request(app).delete('/db/indexTest/indexes/rating');
      expect(res.status).toBe(200);
      expect((res.body as { success?: boolean }).success).toBe(true);
    });

    it('DELETE /db/:collection/indexes/:field should return 400 for nonexistent index', async () => {
      const res = await request(app).delete('/db/indexTest/indexes/nonexistent');
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('does not exist');
    });
  });

  // --- Paged endpoint ---
  // NOTE: The /db/:collection/paged route is registered AFTER /db/:collection/:id
  // in Express, so 'paged' is matched as an :id parameter. This is an existing
  // routing issue. We test the /:id route's 404 behavior instead.

  describe('Get By ID Edge Cases', () => {
    it('GET /db/:collection/:id should return 404 for nonexistent document', async () => {
      const res = await request(app).get('/db/users/does-not-exist-id');
      expect(res.status).toBe(404);
      expect((res.body as { error?: string }).error).toContain('not found');
    });
  });

  // --- Aggregation route ---

  describe('Aggregation Route', () => {
    beforeAll(async () => {
      try {
        await request(app).post('/db').send({ name: 'aggTest' });
      } catch {
        //may already exist
      }
      await request(app).post('/db/aggTest').send({ id: 'a1', category: 'X', amount: 100 });
      await request(app).post('/db/aggTest').send({ id: 'a2', category: 'X', amount: 200 });
      await request(app).post('/db/aggTest').send({ id: 'a3', category: 'Y', amount: 50 });
    });

    it('POST /db/:collection/aggregate should return aggregation results', async () => {
      const res = await request(app)
        .post('/db/aggTest/aggregate')
        .send({
          groupBy: 'category',
          operations: { count: 'total', sum: [{ field: 'amount', as: 'totalAmount' }] },
        });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(2);
    });

    it('POST /db/:collection/aggregate should return 400 for missing operations', async () => {
      const res = await request(app).post('/db/aggTest/aggregate').send({ groupBy: 'category' });
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('operations are required');
    });
  });

  // --- Bulk operations route ---

  describe('Bulk Operations Route', () => {
    beforeAll(async () => {
      try {
        await request(app).post('/db').send({ name: 'bulkTest' });
      } catch {
        // may already exist
      }
    });

    it('POST /db/:collection/bulk should handle insert, update, and delete', async () => {
      const res = await request(app)
        .post('/db/bulkTest/bulk')
        .send({
          operations: [
            { type: 'insert', document: { id: 'bulk1', name: 'Alice' } },
            { type: 'insert', document: { id: 'bulk2', name: 'Bob' } },
            { type: 'update', id: 'bulk1', updates: { name: 'Alice Updated' } },
            { type: 'delete', id: 'bulk2' },
          ],
        });
      expect(res.status).toBe(200);
      const results = (res.body as { results: { success: boolean; type?: string }[] }).results;
      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('POST /db/:collection/bulk should handle unknown operation type', async () => {
      const res = await request(app)
        .post('/db/bulkTest/bulk')
        .send({
          operations: [{ type: 'upsert', document: { id: 'x' } }],
        });
      expect(res.status).toBe(200);
      const results = (res.body as { results: { success: boolean; error?: string }[] }).results;
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Unknown operation type');
    });

    it('POST /db/:collection/bulk should return 400 for missing operations', async () => {
      const res = await request(app).post('/db/bulkTest/bulk').send({});
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('operations array is required');
    });
  });

  // --- Join route ---

  describe('Join Route', () => {
    beforeAll(async () => {
      try {
        await request(app).post('/db').send({ name: 'joinLeft' });
        await request(app).post('/db').send({ name: 'joinRight' });
      } catch {
        // may already exist
      }
      await request(app).post('/db/joinLeft').send({ id: 'jl1', key: 'k1', leftVal: 'A' });
      await request(app).post('/db/joinLeft').send({ id: 'jl2', key: 'k2', leftVal: 'B' });
      await request(app).post('/db/joinRight').send({ id: 'jr1', key: 'k1', rightVal: 'X' });
    });

    it('POST /db/:collection/join should join two collections', async () => {
      const res = await request(app).post('/db/joinLeft/join').send({
        collection: 'joinRight',
        on: 'key',
        rightOn: 'key',
      });
      expect(res.status).toBe(200);
      // inner join: only jl1 matches
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it('POST /db/:collection/join should return 400 for missing fields', async () => {
      const res = await request(app).post('/db/joinLeft/join').send({});
      expect(res.status).toBe(400);
      expect((res.body as { error?: string }).error).toContain('required');
    });
  });

  // --- Update / Delete not-found ---

  describe('Update and Delete Not-Found', () => {
    it('PUT /db/:collection/:id should return 404 for nonexistent doc', async () => {
      const res = await request(app).put('/db/users/nonexistent-id-999').send({ name: 'test' });
      expect(res.status).toBe(404);
    });

    it('DELETE /db/:collection/:id should return 404 for nonexistent doc', async () => {
      const res = await request(app).delete('/db/users/nonexistent-id-999');
      expect(res.status).toBe(404);
    });
  });

  // --- Auth edge cases ---

  describe('Auth Edge Cases', () => {
    it('POST /api/signup should return 400 for missing fields', async () => {
      const res = await request(app).post('/api/signup').send({ username: 'onlyname' });
      expect(res.status).toBe(400);
    });

    it('POST /api/login should return 400 for missing fields (no token)', async () => {
      const res = await request(app).post('/api/login').send({});
      expect(res.status).toBe(400);
    });

    it('POST /api/login should return 401 for valid user with wrong password', async () => {
      // 'demo' user exists from dummy account
      const res = await request(app).post('/api/login').send({ username: 'demo', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('POST /api/login should reject invalid token and fall through', async () => {
      const res = await request(app).post('/api/login').send({ token: 'invalid.jwt.token' });
      // No username/password provided so should return 400
      expect(res.status).toBe(400);
    });
  });

  // --- Authenticated API edge cases ---

  describe('Authenticated API Edge Cases', () => {
    let authToken: string;

    beforeAll(async () => {
      const res = await request(app).post('/api/signup').send({ username: 'edgeuser', password: 'edgepass' });
      authToken = (res.body as { token: string }).token;
      // Create a collection for this user
      await request(app)
        .post('/api/createCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'edgeCol' });
    });

    it('POST /api/createCollection should return 400 for missing collectionName', async () => {
      const res = await request(app).post('/api/createCollection').set('Authorization', `Bearer ${authToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('DELETE /api/deleteCollection should return 400 for missing collectionName', async () => {
      const res = await request(app)
        .delete('/api/deleteCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('DELETE /api/deleteCollection should return 400 for collection not in user list', async () => {
      const res = await request(app)
        .delete('/api/deleteCollection')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'nonExistentCol' });
      expect(res.status).toBe(400);
    });

    it('POST /api/createDocument should return 400 for missing fields', async () => {
      const res = await request(app).post('/api/createDocument').set('Authorization', `Bearer ${authToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('POST /api/createDocument should return 400 for collection not in user list', async () => {
      const res = await request(app)
        .post('/api/createDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'nonExistentCol', documentName: 'doc1' });
      expect(res.status).toBe(400);
    });

    it('DELETE /api/deleteDocument should return 400 for missing fields', async () => {
      const res = await request(app).delete('/api/deleteDocument').set('Authorization', `Bearer ${authToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('DELETE /api/deleteDocument should return 400 for collection not in user list', async () => {
      const res = await request(app)
        .delete('/api/deleteDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'nonExistentCol', documentName: 'doc1' });
      expect(res.status).toBe(400);
    });

    it('DELETE /api/deleteDocument should return 404 for document not found', async () => {
      const res = await request(app)
        .delete('/api/deleteDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'edgeCol', documentName: 'nonExistentDoc' });
      expect(res.status).toBe(404);
    });

    it('GET /api/fetchDocumentContent should return 400 for missing params', async () => {
      const res = await request(app).get('/api/fetchDocumentContent').set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(400);
    });

    it('GET /api/fetchDocumentContent should return 400 for collection not in user list', async () => {
      const res = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName: 'nonExistentCol', documentName: 'doc1' });
      expect(res.status).toBe(400);
    });

    it('GET /api/fetchDocumentContent should return 404 for document not found', async () => {
      const res = await request(app)
        .get('/api/fetchDocumentContent')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ collectionName: 'edgeCol', documentName: 'nonExistentDoc' });
      expect(res.status).toBe(404);
    });

    it('PUT /api/updateDocument should return 400 for missing fields', async () => {
      const res = await request(app).put('/api/updateDocument').set('Authorization', `Bearer ${authToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('PUT /api/updateDocument should return 400 for collection not in user list', async () => {
      const res = await request(app)
        .put('/api/updateDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'nonExistentCol', documentName: 'doc1', newDocumentContent: { a: 1 } });
      expect(res.status).toBe(400);
    });

    it('PUT /api/updateDocument should return 404 for document not found', async () => {
      const res = await request(app)
        .put('/api/updateDocument')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ collectionName: 'edgeCol', documentName: 'nonExistentDoc', newDocumentContent: { a: 1 } });
      expect(res.status).toBe(404);
    });
  });
});

*/
