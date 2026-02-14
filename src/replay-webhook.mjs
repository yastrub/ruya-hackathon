import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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
  const secret = String(process.env.ELEVENLABS_WEBHOOK_SECRET ?? '').trim();

  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify(payload);

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    headers['elevenlabs-signature'] = `t=${timestamp},v0=${signature}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
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
