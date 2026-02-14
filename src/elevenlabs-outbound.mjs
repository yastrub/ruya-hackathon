import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS_PATH = path.join(ROOT, 'data', 'voice-calls-latest.json');

function getEnv(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function normalizeE164Phone(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[()\-\s]/g, '');
  if (!cleaned.startsWith('+')) return null;
  const digits = cleaned.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureLanguage(payload, language) {
  const targetLanguage = String(language || 'en').toLowerCase();
  const out = deepClone(payload ?? {});

  if (!out.conversation_config_override || typeof out.conversation_config_override !== 'object') {
    out.conversation_config_override = {};
  }

  if (!out.conversation_config_override.agent || typeof out.conversation_config_override.agent !== 'object') {
    out.conversation_config_override.agent = {};
  }

  if (!out.conversation_config_override.agent.language) {
    out.conversation_config_override.agent.language = targetLanguage;
  }

  return out;
}

function parseJsonEnv(name, fallback) {
  const raw = getEnv(name, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildClientData(context) {
  const dynamicFromEnv = parseJsonEnv('ELEVENLABS_DYNAMIC_VARIABLES_JSON', {});
  const initiationFromEnv = parseJsonEnv('ELEVENLABS_CONVERSATION_INIT_JSON', {});

  const merged = {
    ...initiationFromEnv,
    dynamic_variables: {
      ...(initiationFromEnv.dynamic_variables && typeof initiationFromEnv.dynamic_variables === 'object'
        ? initiationFromEnv.dynamic_variables
        : {}),
      ...dynamicFromEnv,
      lead_id: context.leadId,
      lead_name: context.leadName,
      lead_goal: context.goal,
      objection_type: context.objectionType,
      objection_sentiment: context.sentiment,
      selected_strategy: context.strategy,
      score: String(context.score),
      text_channel: context.textChannel,
    },
  };

  return ensureLanguage(merged, getEnv('ELEVENLABS_LANGUAGE', 'en'));
}

async function writeArtifacts(result) {
  await fs.writeFile(ARTIFACTS_PATH, JSON.stringify(result, null, 2) + '\n', 'utf-8');
}

export async function startElevenLabsOutboundCall(params) {
  const mode = getEnv('VOICE_MODE', 'dry-run');
  const outboundUrl = getEnv('ELEVENLABS_OUTBOUND_CALL_URL', 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
  const apiKey = getEnv('ELEVENLABS_API_KEY');
  const agentId = getEnv('ELEVENLABS_AGENT_ID');
  const agentPhoneNumberId = getEnv('ELEVENLABS_AGENT_PHONE_NUMBER_ID');

  const toNumber = normalizeE164Phone(params.toNumber);
  if (!toNumber) {
    return {
      ok: false,
      status: 'INVALID_PHONE',
      error: `Invalid E.164 phone: ${params.toNumber}`,
    };
  }

  const payload = {
    agent_id: agentId || 'agent_placeholder',
    agent_phone_number_id: agentPhoneNumberId || 'pn_placeholder',
    to_number: toNumber,
    conversation_initiation_client_data: buildClientData(params.context),
  };

  if (mode !== 'live') {
    const simulated = {
      ok: true,
      status: 'SIMULATED',
      mode,
      request: {
        url: outboundUrl,
        payload,
      },
      context: params.context,
      timestamp: new Date().toISOString(),
    };
    await writeArtifacts(simulated);
    return simulated;
  }

  if (!apiKey || !agentId || !agentPhoneNumberId) {
    return {
      ok: false,
      status: 'MISSING_CONFIG',
      error: 'Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_AGENT_PHONE_NUMBER_ID for live calls.',
    };
  }

  const res = await fetch(outboundUrl, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text().catch(() => '');
  let bodyJson = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    bodyJson = null;
  }

  const result = {
    ok: res.ok,
    status: res.ok ? 'OK' : 'HTTP_ERROR',
    httpStatus: res.status,
    response: bodyJson ?? bodyText,
    request: {
      url: outboundUrl,
      payload: {
        ...payload,
        agent_id: '[redacted]',
        agent_phone_number_id: '[redacted]',
      },
    },
    context: params.context,
    timestamp: new Date().toISOString(),
  };

  await writeArtifacts(result);

  return result;
}
