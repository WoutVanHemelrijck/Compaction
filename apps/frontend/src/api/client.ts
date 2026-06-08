async function request<T>(url: string, options: RequestInit & { authenticated?: boolean } = {}): Promise<T> {
  const { authenticated = true, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authenticated) {
    const token = localStorage.getItem('sessionToken');
    if (!token) {
      window.location.href = '/login';
      throw new Error('Not authenticated');
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...fetchOptions,
    headers: { ...headers, ...(fetchOptions.headers as Record<string, string> | undefined) },
  });

  // Session expired
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('username');
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  const data = (await res.json()) as T & { token?: string; message?: string };

  // Backend lost user state (e.g. after restart) — treat as session expiry
  if (res.status === 404 && typeof data.message === 'string' && data.message.includes('User not found')) {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('username');
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  // Refresh token if the server sent a new one
  if (data.token && typeof data.token === 'string') {
    localStorage.setItem('sessionToken', data.token);
  }

  if (!res.ok) {
    throw new Error(data.message ?? `Request failed (${res.status})`);
  }

  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<{ token: string }> {
  return request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    authenticated: false,
  });
}

export async function signup(username: string, password: string): Promise<{ token: string }> {
  return request('/api/signup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    authenticated: false,
  });
}

// ── Collections ───────────────────────────────────────────────────────────────

export async function fetchCollections(): Promise<string[]> {
  const data = await request<{ collections: string[] }>('/api/fetchCollections');
  return data.collections;
}

export async function createCollection(collectionName: string): Promise<void> {
  await request('/api/createCollection', {
    method: 'POST',
    body: JSON.stringify({ collectionName }),
  });
}

export async function deleteCollection(collectionName: string): Promise<void> {
  await request('/api/deleteCollection', {
    method: 'DELETE',
    body: JSON.stringify({ collectionName }),
  });
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function fetchDocumentsPaged(
  collectionName: string,
  limit: number,
  after?: string,
): Promise<{
  documentNames: string[];
  hasNextPage: boolean;
  nextCursor: string | null;
  total: number;
  rangeStart: number;
  rangeEnd: number;
}> {
  let url = `/api/fetchDocumentsPaged?collectionName=${encodeURIComponent(collectionName)}&limit=${limit}`;
  if (after) url += `&after=${encodeURIComponent(after)}`;
  const data = await request<{
    documentNames: string[];
    hasNextPage: boolean;
    nextCursor: string | null;
    total: number;
    rangeStart: number;
    rangeEnd: number;
  }>(url);
  return {
    documentNames: data.documentNames,
    hasNextPage: data.hasNextPage,
    nextCursor: data.nextCursor,
    total: data.total,
    rangeStart: data.rangeStart,
    rangeEnd: data.rangeEnd,
  };
}

export async function fetchDocumentContent(
  collectionName: string,
  documentName: string,
): Promise<Record<string, unknown>> {
  const data = await request<{ documentContent: Record<string, unknown> }>(
    `/api/fetchDocumentContent?collectionName=${encodeURIComponent(collectionName)}&documentName=${encodeURIComponent(documentName)}`,
  );
  return data.documentContent;
}

export async function createDocument(
  collectionName: string,
  documentName: string,
  documentContent: Record<string, unknown>,
): Promise<void> {
  await request('/api/createDocument', {
    method: 'POST',
    body: JSON.stringify({ collectionName, documentName, documentContent }),
  });
}

export async function updateDocument(
  collectionName: string,
  documentName: string,
  newDocumentContent: Record<string, unknown>,
): Promise<void> {
  await request('/api/updateDocument', {
    method: 'PUT',
    body: JSON.stringify({ collectionName, documentName, newDocumentContent }),
  });
}

export async function deleteDocument(collectionName: string, documentName: string): Promise<void> {
  await request('/api/deleteDocument', {
    method: 'DELETE',
    body: JSON.stringify({ collectionName, documentName }),
  });
}

// ── User ──────────────────────────────────────────────────────────────────────

export async function getUserData(): Promise<{ userId: string; username: string; hashedPassword: string }> {
  const data = await request<{ userData: { userId: string; username: string; hashedPassword: string } }>(
    '/api/getUserData',
  );
  return data.userData;
}

export async function getAllUserData(): Promise<Record<string, unknown>> {
  return request('/api/getAllUserData');
}

export interface SearchResult {
  name: string;
  content: Record<string, unknown>;
}

export async function hnswSearch(collectionName: string, query: string, k: number): Promise<SearchResult[]> {
  const data = await request<{ results: SearchResult[] }>(
    `/api/collections/${encodeURIComponent(collectionName)}/hnsw-search`,
    { method: 'POST', body: JSON.stringify({ query, k }), authenticated: true },
  );
  return data.results;
}

export interface RagSource {
  id: string;
  name: string;
}

export interface RagChatResponse {
  answer: string;
  sources: RagSource[];
}

export interface QueryExecutionResponse {
  success: boolean;
  query?: string;
  result?: unknown;
  message?: string;
}

export async function ragChat(collectionName: string, message: string): Promise<RagChatResponse> {
  const data = await request<{ answer: string; sources: RagSource[] }>(
    `/api/collections/${encodeURIComponent(collectionName)}/rag-chat`,
    { method: 'POST', body: JSON.stringify({ message }) },
  );
  return { answer: data.answer, sources: data.sources };
}

export async function executeSqlQuery(query: string): Promise<QueryExecutionResponse> {
  const data = await request<QueryExecutionResponse>('/api/query/sql', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });

  if (data.success === false) {
    throw new Error(data.message ?? 'SQL query failed');
  }

  return data;
}

export async function executeNaturalLanguageQuery(prompt: string): Promise<QueryExecutionResponse> {
  const data = await request<QueryExecutionResponse>('/api/query/natural-language', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });

  if (data.success === false) {
    throw new Error(data.message ?? 'Natural language query failed');
  }

  return data;
}
