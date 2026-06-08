import { SimpleDBMS } from './src/simpledbms.mjs';
import { MockFile } from './src/file/mockfile.mjs';
import { compactDatabase } from './src/compaction/compaction.mjs';

async function test() {
  const dbFile = new MockFile(512);
  const walFile = new MockFile(512);

  let db = await SimpleDBMS.create(dbFile, walFile);
  const users = await db.getCollection('users');
  await users.insert({ id: 'u1', name: 'Alice', age: 30 });
  await users.insert({ id: 'u2', name: 'Bob', age: 25 });
  await users.insert({ id: 'u3', name: 'Charlie', age: 35 });

  const before = await users.find();
  console.log('Before compaction count:', before.length);

  const { db: newDb } = await compactDatabase(db, dbFile, walFile);
  db = newDb;

  const newUsers = await db.getCollection('users');
  const all = await newUsers.find();
  console.log(
    'After compaction count:',
    all.length,
    all.map((d) => d.id),
  );

  await db.close();
}

test().catch(console.error);
