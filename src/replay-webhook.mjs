import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SAMPLE_PATH = path.join(ROOT, 'data', 'sample-post-call-webhook.json');

function getArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;
  const [, value] = found.split('=');
  return value ?? fallback;
}

async function main() {
  const url = getArg('url', 'http://localhost:8787/webhooks/elevenlabs');
  const raw = await fs.readFile(SAMPLE_PATH, 'utf-8');
  const payload = JSON.parse(raw);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`POST ${url}`);
  console.log(`Status: ${res.status}`);
  console.log(`Body: ${text}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
