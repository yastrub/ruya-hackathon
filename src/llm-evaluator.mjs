function getEnv(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function getEvaluatorConfig() {
  const mode = getEnv('EVALUATOR_MODE', 'auto').toLowerCase();
  const apiUrl = getEnv('EVALUATOR_API_URL', 'https://api.openai.com/v1/chat/completions');
  const apiKey = getEnv('EVALUATOR_API_KEY', '');
  const model = getEnv('EVALUATOR_MODEL', 'gpt-4o-mini');
  const timeoutMs = Number(getEnv('EVALUATOR_TIMEOUT_MS', '12000'));

  return {
    mode,
    apiUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000,
  };
}

function shouldUseLlm(config) {
  if (config.mode === 'rule') return false;
  if (config.mode === 'llm') return true;
  return !!config.apiKey;
}

function parseJsonObjectFromText(raw) {
  if (!raw || typeof raw !== 'string') return null;

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = raw.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeScoring(raw) {
  const score = Number(raw?.score);
  const conversionProbability = Number(raw?.conversionProbability);

  if (!Number.isFinite(score) || !Number.isFinite(conversionProbability)) {
    return null;
  }

  const boundedScore = Math.max(1, Math.min(10, score));
  const boundedProb = Math.max(0.05, Math.min(0.95, conversionProbability));

  return {
    score: Number(boundedScore.toFixed(2)),
    conversionProbability: Number(boundedProb.toFixed(2)),
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 300) : null,
  };
}

function buildPrompt({ lead, strategy, response }) {
  return [
    'You are evaluating an AI sales closer reply.',
    'Return only valid JSON object with keys: score, conversionProbability, notes.',
    'Scoring rubric:',
    '- score: 1..10 overall response quality for this lead context.',
    '- conversionProbability: 0.05..0.95 estimated chance this lead books next step.',
    '- notes: short rationale (< 30 words).',
    '',
    'Lead context:',
    JSON.stringify(
      {
        id: lead.id,
        name: lead.name,
        channel: lead.channel,
        goal: lead.goal,
        objectionType: lead.objectionType,
        sentiment: lead.sentiment,
        leadMessage: lead.message,
      },
      null,
      2,
    ),
    '',
    `Chosen strategy: ${strategy}`,
    `Proposed response: ${response}`,
    '',
    'Output JSON example:',
    '{"score":7.8,"conversionProbability":0.64,"notes":"Addresses objection and gives clear next step."}',
  ].join('\n');
}

export function evaluateByRules({ lead, strategy, response }) {
  let score = 5.5;

  const objectionBoost = {
    price: { consultative: 1.0, social_proof: 0.7, urgent_offer: 0.2 },
    trust: { consultative: 0.8, social_proof: 1.2, urgent_offer: 0.2 },
    timing: { consultative: 0.6, social_proof: 0.4, urgent_offer: 1.1 },
    results: { consultative: 0.7, social_proof: 1.0, urgent_offer: 0.3 },
    complexity: { consultative: 1.1, social_proof: 0.5, urgent_offer: 0.1 },
    urgency: { consultative: 0.5, social_proof: 0.4, urgent_offer: 1.0 },
  };

  score += objectionBoost[lead.objectionType]?.[strategy] ?? 0.2;

  if (response.includes(lead.name)) score += 0.4;
  if (response.includes(lead.goal)) score += 0.6;
  if (response.toLowerCase().includes('step')) score += 0.4;
  if (response.toLowerCase().includes('week')) score += 0.2;

  const sentimentPenalty = {
    skeptical: -0.2,
    overwhelmed: -0.2,
  };
  score += sentimentPenalty[lead.sentiment] ?? 0;

  if (strategy === 'urgent_offer' && ['skeptical', 'overwhelmed'].includes(lead.sentiment)) {
    score -= 0.3;
  }

  const bounded = Math.max(1, Math.min(10, score));
  const conversionProbability = Math.max(0.05, Math.min(0.92, (bounded - 3) / 8));

  return {
    score: Number(bounded.toFixed(2)),
    conversionProbability: Number(conversionProbability.toFixed(2)),
    source: 'rule',
    notes: null,
  };
}

async function evaluateByLlm({ config, lead, strategy, response }) {
  const prompt = buildPrompt({ lead, strategy, response });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(config.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a strict JSON scoring engine. Return only JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    const rawText = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `LLM HTTP ${res.status}: ${rawText.slice(0, 400)}`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        error: `LLM response is not JSON: ${rawText.slice(0, 400)}`,
      };
    }

    const content = parsed?.choices?.[0]?.message?.content ?? '';
    const json = parseJsonObjectFromText(typeof content === 'string' ? content : JSON.stringify(content));
    const normalized = normalizeScoring(json);

    if (!normalized) {
      return {
        ok: false,
        error: `LLM returned invalid scoring payload: ${String(content).slice(0, 400)}`,
      };
    }

    return {
      ok: true,
      value: {
        ...normalized,
        source: 'llm',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `LLM request failed: ${String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function evaluateLeadAdaptive({ lead, strategy, response }) {
  const config = getEvaluatorConfig();

  if (!shouldUseLlm(config)) {
    return evaluateByRules({ lead, strategy, response });
  }

  const llm = await evaluateByLlm({ config, lead, strategy, response });
  if (llm.ok) {
    return llm.value;
  }

  const fallback = evaluateByRules({ lead, strategy, response });
  return {
    ...fallback,
    notes: llm.error,
    source: 'rule_fallback',
  };
}
