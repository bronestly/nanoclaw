/**
 * Vault Indexer — semantic search for the Obsidian vault.
 *
 * Uses bge-m3 via Ollama to embed markdown chunks, stores the index
 * at <vault>/.vault-search/index.json for the agent container to query.
 */

import { createHash } from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import chokidar from 'chokidar';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const VAULT_PATH = '/Users/reen/Documents/secondbrain';
const INDEX_DIR = path.join(VAULT_PATH, '.vault-search');
const INDEX_PATH = path.join(INDEX_DIR, 'index.json');
const OLLAMA_URL = 'http://localhost:11434';
const EMBEDDING_MODEL = 'bge-m3';
const MAX_CHUNK_CHARS = 1000;
const OLLAMA_BIN = '/opt/homebrew/bin/ollama';

// Dirs to skip when walking the vault
const SKIP_DIRS = new Set([
  '.git',
  '.obsidian',
  '.stfolder',
  '.vault-search',
  'node_modules',
]);

export interface IndexEntry {
  path: string; // relative to vault root
  text: string; // chunk text (for display in results)
  embedding: string; // base64-encoded Float32Array (1024 dims)
  hash: string; // sha256 prefix for change detection
}

// ─── Ollama helpers ───────────────────────────────────────────────────────────

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureOllama(): Promise<boolean> {
  if (await isOllamaRunning()) return true;

  logger.info('Starting Ollama...');
  exec(`${OLLAMA_BIN} serve`);

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isOllamaRunning()) {
      logger.info('Ollama started');
      return true;
    }
  }

  logger.warn('Ollama did not start in time — vault indexing skipped');
  return false;
}

async function embed(
  text: string,
  abortSignal?: AbortSignal,
): Promise<Float32Array | null> {
  try {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal,
    });
    const data = (await res.json()) as { embeddings: number[][] };
    return new Float32Array(data.embeddings[0]);
  } catch (err) {
    logger.warn({ err }, 'Embed failed');
    return null;
  }
}

function embeddingToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer).toString('base64');
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

function chunkMarkdown(content: string): string[] {
  // Strip YAML frontmatter
  const stripped = content.replace(/^---[\s\S]*?---\n/, '');

  // Split on headings, then size-limit at paragraph boundaries
  const sections = stripped.split(/(?=^#{1,3} )/m);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length < 50) continue;

    if (trimmed.length <= MAX_CHUNK_CHARS) {
      chunks.push(trimmed);
    } else {
      const paras = trimmed.split(/\n\n+/);
      let current = '';
      for (const para of paras) {
        const candidate = current ? `${current}\n\n${para}` : para;
        if (candidate.length > MAX_CHUNK_CHARS && current.length > 50) {
          chunks.push(current.trim());
          current = para;
        } else {
          current = candidate;
        }
      }
      if (current.trim().length > 50) chunks.push(current.trim());
    }
  }

  return chunks;
}

// ─── Vault walker ─────────────────────────────────────────────────────────────

function walkVault(): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  walk(VAULT_PATH);
  return files;
}

// ─── Index build ──────────────────────────────────────────────────────────────

let indexing = false;
let currentAbortController: AbortController | null = null;

export interface IndexStatus {
  running: boolean;
  aborted: boolean;
  indexed: number;
  skipped: number;
  filesTotal: number;
  filesDone: number;
  startedAt: string | null;
  completedAt: string | null;
}

const indexStatus: IndexStatus = {
  running: false,
  aborted: false,
  indexed: 0,
  skipped: 0,
  filesTotal: 0,
  filesDone: 0,
  startedAt: null,
  completedAt: null,
};

export function getIndexStatus(): IndexStatus {
  return { ...indexStatus };
}

/** Abort the currently running index build. Returns false if nothing is running. */
export function abortVaultIndex(): boolean {
  if (!currentAbortController) return false;
  currentAbortController.abort();
  return true;
}

export async function buildVaultIndex(force = false): Promise<void> {
  if (indexing) return;
  indexing = true;

  const controller = new AbortController();
  currentAbortController = controller;
  Object.assign(indexStatus, {
    running: true,
    aborted: false,
    indexed: 0,
    skipped: 0,
    filesTotal: 0,
    filesDone: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  try {
    const ollamaReady = await ensureOllama();
    if (!ollamaReady) return;

    // Load existing index for incremental updates
    const existing = new Map<string, IndexEntry>();
    if (!force && fs.existsSync(INDEX_PATH)) {
      try {
        const entries = JSON.parse(
          fs.readFileSync(INDEX_PATH, 'utf-8'),
        ) as IndexEntry[];
        for (const e of entries) existing.set(`${e.path}::${e.hash}`, e);
      } catch {
        // corrupt index — rebuild
      }
    }

    fs.mkdirSync(INDEX_DIR, { recursive: true });

    const files = walkVault();
    indexStatus.filesTotal = files.length;
    const newEntries: IndexEntry[] = [];

    for (const filePath of files) {
      if (controller.signal.aborted) {
        logger.info('Vault indexing aborted');
        indexStatus.aborted = true;
        break;
      }

      const relPath = path.relative(VAULT_PATH, filePath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        indexStatus.filesDone++;
        continue;
      }

      for (const chunk of chunkMarkdown(content)) {
        if (controller.signal.aborted) break;

        const hash = createHash('sha256')
          .update(chunk)
          .digest('hex')
          .slice(0, 16);
        const key = `${relPath}::${hash}`;

        if (existing.has(key)) {
          newEntries.push(existing.get(key)!);
          indexStatus.skipped++;
          continue;
        }

        const vec = await embed(chunk, controller.signal);
        if (!vec) continue;

        newEntries.push({
          path: relPath,
          text: chunk,
          embedding: embeddingToBase64(vec),
          hash,
        });
        indexStatus.indexed++;
      }

      indexStatus.filesDone++;
    }

    if (!controller.signal.aborted) {
      fs.writeFileSync(INDEX_PATH, JSON.stringify(newEntries));
      logger.info(
        {
          indexed: indexStatus.indexed,
          skipped: indexStatus.skipped,
          total: newEntries.length,
        },
        'Vault index updated',
      );
    }
  } finally {
    indexing = false;
    currentAbortController = null;
    indexStatus.running = false;
    indexStatus.completedAt = new Date().toISOString();
  }
}

// ─── File watcher ─────────────────────────────────────────────────────────────

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  // Debounce: wait 10s after last change before rebuilding
  rebuildTimer = setTimeout(() => {
    logger.info('Vault files changed — rebuilding index');
    buildVaultIndex().catch((err) =>
      logger.error({ err }, 'Index rebuild failed'),
    );
  }, 10_000);
}

export function startVaultWatcher(): void {
  if (!fs.existsSync(VAULT_PATH)) {
    logger.warn(
      { path: VAULT_PATH },
      'Vault path not found — watcher not started',
    );
    return;
  }

  const watcher = chokidar.watch(`${VAULT_PATH}/**/*.md`, {
    ignored: /(\.git|\.obsidian|\.stfolder|\.vault-search)/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  watcher.on('add', scheduleRebuild);
  watcher.on('change', scheduleRebuild);
  watcher.on('unlink', scheduleRebuild);

  logger.info('Vault file watcher started');
}

// ─── Startup ──────────────────────────────────────────────────────────────────

/** Schedule a full (force) rebuild every night at 04:00 local time. */
function scheduleNightlyReindex(): void {
  const now = new Date();
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    4,
    0,
    0,
    0, // 04:00:00.000
  );

  // If 04:00 has already passed today, schedule for tomorrow.
  if (next <= now) next.setDate(next.getDate() + 1);

  const msUntilNext = next.getTime() - now.getTime();
  logger.info(
    { nextRun: next.toISOString(), msUntilNext },
    'Nightly vault reindex scheduled',
  );

  setTimeout(() => {
    logger.info('Running nightly vault reindex (04:00)');
    buildVaultIndex(true).catch((err) =>
      logger.error({ err }, 'Nightly vault reindex failed'),
    );
    // Reschedule for the next night after this one fires.
    scheduleNightlyReindex();
  }, msUntilNext);
}

export function initVaultIndexer(): void {
  // Build index in background on startup (don't block main startup)
  setImmediate(() => {
    buildVaultIndex().catch((err) =>
      logger.error({ err }, 'Initial vault index failed'),
    );
  });

  startVaultWatcher();
  scheduleNightlyReindex();
}
