#!/usr/bin/env bash
set -e

COUCH_URL="http://${COUCHDB_USER:-admin}:${COUCHDB_PASSWORD:-password}@localhost:5984"

echo "Starting CouchDB..."
docker compose up -d

echo "Waiting for CouchDB to be ready..."
until curl -sf "${COUCH_URL}/_up" > /dev/null 2>&1; do
  sleep 1
done
echo "CouchDB is up."

echo "Creating system databases..."
curl -sf -X PUT "${COUCH_URL}/_users" > /dev/null 2>&1 || true
curl -sf -X PUT "${COUCH_URL}/_replicator" > /dev/null 2>&1 || true

echo "Creating obsidian-sync database..."
curl -sf -X PUT "${COUCH_URL}/obsidian-sync" > /dev/null 2>&1 || true

echo ""
echo "CouchDB is ready at http://localhost:5984"
echo "Dashboard: http://localhost:5984/_utils"
echo "Database:  http://localhost:5984/obsidian-sync"
