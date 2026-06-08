// author @woutvanhemelrijck
// date: 24/11/2025

import { EncryptionService } from '../../packages/auth/encryption-service.mjs';
import { Database } from '../../packages/dbms/core/trivialdbms.mjs';
import { RealFile } from '../../packages/dbms/storage/file/file.mjs';

// === SETUP ===
const masterKey = process.env['ENCRYPTION_KEY'] || EncryptionService.generateMasterKey();
const encryptionService = EncryptionService.fromHexKey(masterKey);

// === CREATE NEW DATABASE ===
const file = new RealFile('collection.db');
const db = await Database.create(file, encryptionService);

// === OPERATIES ===
await db.insertRecord(0, { name: 'Alice', email: 'alice@example.com' });
await db.insertRecord(1, { name: 'Bob', email: 'bob@example.com' });

// === COMMIT ===
await db.commit();

// === OPEN DATABASE ===
const db2 = await Database.open(file, encryptionService);
const records = await db2.getRecords();
console.log(records); // ✅ Automatisch gedecodeerd!

// === CLOSE ===
await db2.close();
