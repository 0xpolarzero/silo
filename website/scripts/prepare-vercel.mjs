import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

// Package only the built public site using Vercel's Build Output API v3.
const output = new URL('../.vercel/output/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../dist/', import.meta.url), new URL('static/', output), { recursive: true });
await writeFile(new URL('config.json', output), JSON.stringify({ version: 3 }) + '\n');
