const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ENV_FILE = path.join(ROOT_DIR, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const state = {
  db: { channels: [], usage: [] },
  rr: new Map(),
  apiKey: ""
};

let dbSaveRunning = false;
let dbSaveQueued = false;
let dbSaveVersion = 0;

function backupBadFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.bad-${Date.now()}`;
  try {
    fs.renameSync(file, backup);
    console.warn(`Invalid data file moved to ${backup}`);
  } catch (error) {
    console.warn(`Failed to backup invalid file ${file}: ${error.message}`);
  }
}

const PORT = Number(process.env.PORT || 8880);
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || KEEP_ALIVE_TIMEOUT_MS + 1000);

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.apiKey = process.env.PROXY_API_KEY || "pwd";
  if (fs.existsSync(DB_FILE)) {
    try {
      const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      state.db = {
        channels: Array.isArray(db.channels) ? db.channels : [],
        usage: Array.isArray(db.usage) ? db.usage : []
      };
    } catch (error) {
      console.warn(`Failed to read data/db.json: ${error.message}`);
      backupBadFile(DB_FILE);
      state.db = { channels: [], usage: [] };
      saveDb();
    }
  } else {
    saveDb();
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbSaveVersion += 1;
  fs.writeFileSync(DB_FILE, JSON.stringify(state.db, null, 2));
}

function queueDbSave() {
  dbSaveVersion += 1;
  dbSaveQueued = true;
  if (dbSaveRunning) return;

  dbSaveRunning = true;
  setImmediate(async () => {
    while (dbSaveQueued) {
      dbSaveQueued = false;
      const version = dbSaveVersion;
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        await fs.promises.writeFile(DB_FILE, JSON.stringify(state.db, null, 2));
        if (version !== dbSaveVersion) dbSaveQueued = true;
      } catch (error) {
        console.warn(`Failed to save data/db.json: ${error.message}`);
      }
    }
    dbSaveRunning = false;
  });
}

function usageRecord(record) {
  state.db.usage.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    ...record
  });
  state.db.usage = state.db.usage.slice(0, 1000);
  queueDbSave();
}

module.exports = {
  PUBLIC_DIR,
  PORT,
  KEEP_ALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  state,
  ensureData,
  saveDb,
  usageRecord
};
