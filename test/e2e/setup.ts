/**
 * Docker CouchDB lifecycle for e2e tests.
 */
import { execSync } from "child_process";
import { randomBytes } from "crypto";
import path from "path";

const COMPOSE_FILE = path.resolve(__dirname, "../../server/docker-compose.yml");
const PROJECT_PREFIX = "sync-e2e";

export interface CouchDBContext {
  url: string;
  dbName: string;
  username: string;
  password: string;
  projectName: string;
  port: number;
}

let context: CouchDBContext | null = null;

function run(cmd: string, env?: Record<string, string>): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

export async function startCouchDB(): Promise<CouchDBContext> {
  if (context !== null) return context;

  const port = 15984 + Math.floor(Math.random() * 10000);
  const projectName = `${PROJECT_PREFIX}-${randomBytes(4).toString("hex")}`;
  const username = "admin";
  const password = "testpassword";
  const dbName = `test-${randomBytes(4).toString("hex")}`;

  const composeEnv = { COUCHDB_USER: username, COUCHDB_PASSWORD: password };

  // Write a compose override with our random port
  const overrideFile = `/tmp/${projectName}-override.yml`;
  const override = `services:\n  couchdb:\n    ports:\n      - "${port}:5984"`;
  execSync(`cat > ${overrideFile} << 'YAML'\n${override}\nYAML`);

  run(`docker compose -f ${COMPOSE_FILE} -f ${overrideFile} -p ${projectName} up -d`, composeEnv);

  const baseUrl = `http://${username}:${password}@localhost:${port}`;

  // Wait for CouchDB to be ready (up to 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      run(`curl -sf ${baseUrl}/_up`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Final check
  run(`curl -sf ${baseUrl}/_up`);

  // Create system + test databases
  for (const db of ["_users", "_replicator", dbName]) {
    try {
      run(`curl -sf -X PUT ${baseUrl}/${db}`);
    } catch {
      /* already exists */
    }
  }

  context = { url: `http://localhost:${port}`, dbName, username, password, projectName, port };
  return context;
}

export async function stopCouchDB(): Promise<void> {
  if (context === null) return;
  const { projectName } = context;
  try {
    run(`docker compose -f ${COMPOSE_FILE} -p ${projectName} down -v`);
  } catch {
    /* best effort */
  }
  try {
    run(`rm -f /tmp/${projectName}-override.yml`);
  } catch {
    /* ignore */
  }
  context = null;
}
