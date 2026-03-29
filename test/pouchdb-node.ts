/**
 * PouchDB shim for Node.js tests.
 *
 * We can't use the full `pouchdb` package because it depends on native
 * leveldown bindings. Instead, we assemble PouchDB from core plugins
 * with the in-memory adapter (memdown-based) so tests run without any
 * native dependencies.
 */
import PouchDB from 'pouchdb-core';
import AdapterMemory from 'pouchdb-adapter-memory';
import HttpAdapter from 'pouchdb-adapter-http';
import Replication from 'pouchdb-replication';
import Mapreduce from 'pouchdb-mapreduce';

PouchDB.plugin(AdapterMemory);
PouchDB.plugin(HttpAdapter);
PouchDB.plugin(Replication);
PouchDB.plugin(Mapreduce);

// Make 'memory' the default adapter so `new PouchDB('name')` uses it
// without the caller needing to specify `{ adapter: 'memory' }`.
const OrigPouchDB = PouchDB;

function PatchedPouchDB(name: any, opts?: any) {
  if (typeof name === 'string' && !name.startsWith('http')) {
    opts = { adapter: 'memory', ...opts };
  }
  // @ts-expect-error — calling class as function via new
  return new OrigPouchDB(name, opts);
}

// Copy static properties
Object.setPrototypeOf(PatchedPouchDB, OrigPouchDB);
PatchedPouchDB.prototype = OrigPouchDB.prototype;

export default PatchedPouchDB as unknown as typeof PouchDB;
