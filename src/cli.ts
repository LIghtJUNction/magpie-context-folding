#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { constants } from 'node:fs';
import { readdir, lstat, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const usage = `Usage: magpie-context-folding <command> [--dir ARCHIVE] [options]

stats                         File count and total bytes
list [--sort name|size|time] [--order asc|desc]
read HASH                     Write exact original text to stdout
search TEXT                   Print path:line:text literal matches
clean [HASH | --older-than DAYS] [--apply]

--dir selects the folder containing SHA-256.txt files.
Default: $MAGPIE_CONTEXT_FOLDING_STATE_DIR/archive, or the XDG data directory.
HASH accepts a full hash or an unambiguous prefix of at least 12 hex digits.
clean previews selected files; --apply deletes them. No selector is an error.
Only regular SHA-256.txt files are managed. No database or scope is needed.
list, stats and clean output JSON; read outputs raw text. Errors exit 1.`;
const filename = /^([a-f0-9]{64})\.txt$/;
type File = { hash: string; path: string; bytes: number; modified: number };

async function files(directory: string): Promise<File[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: File[] = [];
  for (const name of names) {
    const hash = filename.exec(name)?.[1];
    if (!hash) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile()) result.push({ hash, path, bytes: info.size, modified: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}

function select(entries: File[], hash: string | undefined): File {
  if (!hash || !/^[a-f0-9]{12,64}$/.test(hash)) throw new Error('Expected a hash of 12–64 lowercase hex digits');
  const matches = entries.filter(file => file.hash.startsWith(hash));
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous hash prefix' : 'Archive file not found');
  return matches[0]!;
}

async function read(file: File): Promise<string> {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular archive file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') { console.log(usage); return; }
  const common = { dir: { type: 'string' }, help: { type: 'boolean' } } as const;
  const specific: Record<string, ParseArgsConfig['options']> = {
    stats: {}, list: { sort: { type: 'string' }, order: { type: 'string' } },
    read: {}, search: {}, clean: { 'older-than': { type: 'string' }, apply: { type: 'boolean' } },
  };
  if (!Object.hasOwn(specific, command)) throw new Error('Unknown command; use --help');
  const parsed = parseArgs({ args, allowPositionals: true, strict: true,
    options: { ...common, ...specific[command as keyof typeof specific] } });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;
  if (values.help) { console.log(usage); return; }
  if (values.dir !== undefined && (typeof values.dir !== 'string' || !values.dir.trim())) throw new Error('Expected --dir PATH');
  const state = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR
    ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'magpie-context-folding');
  const directory = resolve(values.dir as string ?? join(state, 'archive'));
  const entries = await files(directory);
  if (positionals.length > (['read', 'search', 'clean'].includes(command) ? 1 : 0)) throw new Error('Unexpected positional arguments');
  if (command === 'read') { await Bun.write(Bun.stdout, await read(select(entries, positionals[0]))); return; }
  if (command === 'search') {
    const query = positionals[0];
    if (!query) throw new Error('Expected nonempty search text');
    for (const file of entries.sort((a, b) => a.hash.localeCompare(b.hash))) {
      const lines = (await read(file)).split(/\r\n|\r|\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index]!.includes(query)) console.log(`${file.path}:${index + 1}:${lines[index]}`);
      }
    }
    return;
  }
  if (command === 'stats') {
    console.log(JSON.stringify({ directory, files: entries.length, bytes: entries.reduce((sum, file) => sum + file.bytes, 0) }));
    return;
  }
  if (command === 'list') {
    const sort = values.sort ?? 'time';
    const order = values.order ?? 'desc';
    if (!['name', 'size', 'time'].includes(String(sort)) || !['asc', 'desc'].includes(String(order))) throw new Error('Invalid sort/order');
    entries.sort((a, b) => (sort === 'size' ? a.bytes - b.bytes : sort === 'time' ? a.modified - b.modified : a.hash.localeCompare(b.hash))
      * (order === 'asc' ? 1 : -1) || a.hash.localeCompare(b.hash));
    console.log(JSON.stringify(entries));
    return;
  }
  if ((positionals[0] !== undefined) === (values['older-than'] !== undefined)) throw new Error('Choose HASH or --older-than DAYS');
  let selected: File[];
  if (positionals[0]) selected = [select(entries, positionals[0])];
  else {
    const days = String(values['older-than']);
    if (!/^\d+(?:\.\d+)?$/.test(days) || !Number.isFinite(Number(days))) throw new Error('Expected nonnegative days');
    const cutoff = Date.now() - Number(days) * 86_400_000;
    selected = entries.filter(file => file.modified < cutoff);
  }
  if (values.apply) for (const file of selected) await unlink(file.path);
  console.log(JSON.stringify({ applied: values.apply === true, files: selected, bytes: selected.reduce((sum, file) => sum + file.bytes, 0) }));
}

try { await main(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
