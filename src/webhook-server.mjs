import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LATEST_PATH = path.join(DATA_DIR, 'post-call-latest.json');
const NDJSON_PATH = path.join(DATA_DIR, 'post-call-events.ndjson');
const LEARNING_PATH = path.join(DATA_DIR, 'post-call-learning.json');

function getArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;
  const [, value] = found.split('=');
  return value ?? fallback;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractCallEvent(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const metadata = data?.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const transcript = Array.isArray(data?.transcript) ? data.transcript : [];
  const dynamicVariables =
    metadata?.dynamic_variables && typeof metadata.dynamic_variables === 'object'
      ? metadata.dynamic_variables
      : {};

  const durationSeconds = safeNumber(metadata?.duration_seconds, 0);
  const leadId =
    (dynamicVariables?.lead_id && String(dynamicVariables.lead_id)) ||
    (data?.conversation_initiation_client_data?.dynamic_variables?.lead_id &&
      String(data.conversation_initiation_client_data.dynamic_variables.lead_id)) ||
    null;

  const userTurns = transcript.filter((t) => String(t?.sender ?? '').toLowerCase() === 'user');
  const agentTurns = transcript.filter((t) => String(t?.sender ?? '').toLowerCase() === 'agent');

  return {
    receivedAt: new Date().toISOString(),
    type: String(payload?.type ?? ''),
    conversationId: String(data?.conversation_id ?? metadata?.conversation_id ?? ''),
    durationSeconds,
    leadId,
    transcriptTurns: transcript.length,
    userTurns: userTurns.length,
    agentTurns: agentTurns.length,
    transcriptPreview: transcript.slice(0, 5).map((t) => ({
      sender: t?.sender ?? null,
      text: typeof t?.text === 'string' ? t.text.slice(0, 200) : null,
      timestamp: t?.timestamp ?? null,
    })),
    dynamicVariables,
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function appendNdjson(filePath, value) {
  await fs.appendFile(filePath, JSON.stringify(value) + '\n', 'utf-8');
}

async function upsertLearning(event) {
  let learning = {
    updatedAt: null,
    callsCount: 0,
    totalDurationSeconds: 0,
    avgDurationSeconds: 0,
    byLeadId: {},
  };

  try {
    const raw = await fs.readFile(LEARNING_PATH, 'utf-8');
    learning = JSON.parse(raw);
  } catch {
    // keep defaults
  }

  learning.callsCount += 1;
  learning.totalDurationSeconds += event.durationSeconds;
  learning.avgDurationSeconds = Number(
    (learning.totalDurationSeconds / Math.max(1, learning.callsCount)).toFixed(2),
  );

  const leadKey = event.leadId || 'unknown';
  const prev = learning.byLeadId[leadKey] || {
    callsCount: 0,
    totalDurationSeconds: 0,
    avgDurationSeconds: 0,
    lastConversationId: null,
    lastReceivedAt: null,
  };

  prev.callsCount += 1;
  prev.totalDurationSeconds += event.durationSeconds;
  prev.avgDurationSeconds = Number((prev.totalDurationSeconds / Math.max(1, prev.callsCount)).toFixed(2));
  prev.lastConversationId = event.conversationId || null;
  prev.lastReceivedAt = event.receivedAt;

  learning.byLeadId[leadKey] = prev;
  learning.updatedAt = new Date().toISOString();

  await writeJson(LEARNING_PATH, learning);
}

async function handleWebhook(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      statusCode: 400,
      body: { ok: false, error: 'INVALID_JSON' },
    };
  }

  const event = extractCallEvent(payload);

  await writeJson(LATEST_PATH, { event, raw: payload });
  await appendNdjson(NDJSON_PATH, { event, raw: payload });
  await upsertLearning(event);

  return {
    ok: true,
    statusCode: 200,
    body: {
      ok: true,
      receivedType: event.type,
      conversationId: event.conversationId,
      durationSeconds: event.durationSeconds,
      leadId: event.leadId,
    },
  };
}

async function main() {
  const port = Number(getArg('port', process.env.PORT || '8787'));
  const once = getArg('once', 'false') === 'true';

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/elevenlabs') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const result = await handleWebhook(rawBody);
        res.writeHead(result.statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));

        if (once) {
          server.close(() => process.exit(0));
        }
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', message: String(error) }));
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`ElevenLabs webhook stub listening on http://localhost:${port}/webhooks/elevenlabs`);
    console.log(`Artifacts: ${LATEST_PATH}, ${NDJSON_PATH}, ${LEARNING_PATH}`);
    if (once) {
      console.log('Mode: once=true (server exits after first valid request).');
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
