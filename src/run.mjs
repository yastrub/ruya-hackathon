import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startElevenLabsOutboundCall } from './elevenlabs-outbound.mjs';
import { evaluateLeadAdaptive } from './llm-evaluator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_PATH = path.join(DATA_DIR, 'leads.json');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
const REPORT_PATH = path.join(DATA_DIR, 'report-latest.json');

const STRATEGIES = ['consultative', 'social_proof', 'urgent_offer'];
const TEXT_CHANNELS = ['instagram_dm', 'whatsapp'];

const STRATEGY_TEMPLATES = {
  consultative: ({ lead }) =>
    [
      `Totally fair point, ${lead.name}. Before recommending anything expensive, I want to map your exact goal: ${lead.goal}.`,
      `If we can solve your ${lead.objectionType} concern with a low-risk first step, would you be open to a quick start this week?`,
      `I can offer a structured first step and a clear success checkpoint so you can decide based on results, not promises.`,
    ].join(' '),
  social_proof: ({ lead }) =>
    [
      `${lead.name}, great question. We recently helped clients with the same concern (${lead.objectionType}) and they converted after seeing a guided first win in week 1.`,
      `For your case (${lead.offer}), we can start with the same proven sequence and track progress clearly.`,
      `If you want, I can share the exact 3-step plan and reserve your onboarding slot.`,
    ].join(' '),
  urgent_offer: ({ lead }) =>
    [
      `${lead.name}, understood. To reduce risk, we can lock a fast-start option today and keep commitment light.`,
      `This lets you test ${lead.offer} quickly and decide from real momentum, not overthinking.`,
      `If we start now, I can secure the current onboarding window and set your first measurable milestone this week.`,
    ].join(' '),
};

function getArg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;
  const [, value] = found.split('=');
  return value ?? fallback;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function getAverage(stats) {
  return stats.uses > 0 ? stats.totalScore / stats.uses : 0;
}

function pickBestStrategy(memory, objectionType) {
  const mapped = memory.objectionPolicy?.[objectionType];
  if (mapped && STRATEGIES.includes(mapped)) return mapped;

  let best = STRATEGIES[0];
  let bestScore = -Infinity;
  for (const strategy of STRATEGIES) {
    const avg = memory.strategyStats[strategy]?.avgScore ?? 0;
    if (avg > bestScore) {
      bestScore = avg;
      best = strategy;
    }
  }
  return best;
}

function pickWarmupStrategy(index) {
  return STRATEGIES[index % STRATEGIES.length];
}

function updateMemory(memory, lead, strategy, result, epoch, response, candidateScores) {
  const stats = memory.strategyStats[strategy];
  stats.uses += 1;
  stats.totalScore = Number((stats.totalScore + result.score).toFixed(4));
  stats.avgScore = Number(getAverage(stats).toFixed(4));

  let bestForLead = strategy;
  let bestScore = result.score;
  for (const [candidateStrategy, candidateResult] of Object.entries(candidateScores)) {
    if (candidateResult.score > bestScore) {
      bestScore = candidateResult.score;
      bestForLead = candidateStrategy;
    }
  }
  memory.objectionPolicy[lead.objectionType] = bestForLead;

  memory.history.push({
    timestamp: new Date().toISOString(),
    epoch,
    leadId: lead.id,
    objectionType: lead.objectionType,
    strategy,
    score: result.score,
    conversionProbability: result.conversionProbability,
    responsePreview: response.slice(0, 180),
  });

  if (memory.history.length > 200) {
    memory.history = memory.history.slice(-200);
  }
}

function decayExploration(memory) {
  const epsilon = memory.policy?.epsilon ?? 0.2;
  const decay = memory.policy?.decay ?? 0.8;
  const minEpsilon = memory.policy?.minEpsilon ?? 0.05;
  memory.policy.epsilon = Number(Math.max(minEpsilon, epsilon * decay).toFixed(4));
}

function buildResponse(strategy, lead) {
  return STRATEGY_TEMPLATES[strategy]({ lead });
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function shouldEscalateToVoice({ lead, result, epoch, minEpochForVoice }) {
  const channel = String(lead.channel ?? '').toLowerCase();
  const hasTextChannel = TEXT_CHANNELS.includes(channel);
  const hasPhone = typeof lead.phoneNumber === 'string' && lead.phoneNumber.trim().length > 0;
  const sentiment = String(lead.sentiment ?? '').toLowerCase();
  const frictionSignal =
    sentiment === 'skeptical' ||
    sentiment === 'hesitant' ||
    sentiment === 'overwhelmed' ||
    result.conversionProbability < 0.58;

  return epoch >= minEpochForVoice && hasTextChannel && hasPhone && frictionSignal;
}

async function maybeStartVoiceFollowup({ enabled, lead, result, strategy, epoch }) {
  if (!enabled) {
    return {
      attempted: false,
      reason: 'VOICE_CHANNEL_DISABLED',
    };
  }

  const callResult = await startElevenLabsOutboundCall({
    toNumber: lead.phoneNumber,
    context: {
      leadId: lead.id,
      leadName: lead.name,
      goal: lead.goal,
      objectionType: lead.objectionType,
      sentiment: lead.sentiment,
      strategy,
      score: result.score,
      textChannel: lead.channel,
      epoch,
    },
  });

  return {
    attempted: true,
    ok: callResult.ok,
    status: callResult.status,
    mode: callResult.mode ?? process.env.VOICE_MODE ?? 'dry-run',
    error: callResult.error ?? null,
  };
}

async function main() {
  const epochs = Number(getArg('epochs', '2'));
  const warmupEpochs = Number(getArg('warmupEpochs', '1'));
  const voiceChannelEnabled = getArg('voice', 'on') !== 'off';
  const minEpochForVoice = Number(getArg('voiceFromEpoch', '2'));
  const leads = await readJson(LEADS_PATH);
  const memory = await readJson(MEMORY_PATH);

  const rounds = [];
  const voiceFollowups = [];
  console.log('\n=== Ruya Hackathon: Self-Improving Sales Closer Agent ===');
  console.log(`Leads: ${leads.length} | Epochs: ${epochs}`);
  console.log(`Initial exploration epsilon: ${memory.policy.epsilon}`);
  console.log(`Text channels: ${TEXT_CHANNELS.join(', ')} | Voice channel: ${voiceChannelEnabled ? 'enabled' : 'disabled'} (${process.env.VOICE_MODE ?? 'dry-run'})`);

  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const events = [];
    const epochScores = [];

    console.log(`\n--- Epoch ${epoch} ---`);

    for (const lead of leads) {
      const strategy = epoch <= warmupEpochs ? pickWarmupStrategy(events.length) : pickBestStrategy(memory, lead.objectionType);

      const candidateScores = {};
      for (const candidateStrategy of STRATEGIES) {
        const candidateResponse = buildResponse(candidateStrategy, lead);
        candidateScores[candidateStrategy] = await evaluateLeadAdaptive({
          lead,
          strategy: candidateStrategy,
          response: candidateResponse,
        });
      }

      const response = buildResponse(strategy, lead);
      const result = candidateScores[strategy];
      updateMemory(memory, lead, strategy, result, epoch, response, candidateScores);

      epochScores.push(result.score);
      const bestCandidate = Object.entries(candidateScores).sort((a, b) => b[1].score - a[1].score)[0];
      const escalateToVoice = shouldEscalateToVoice({
        lead,
        result,
        epoch,
        minEpochForVoice,
      });

      const voice = escalateToVoice
        ? await maybeStartVoiceFollowup({
            enabled: voiceChannelEnabled,
            lead,
            result,
            strategy,
            epoch,
          })
        : { attempted: false, reason: 'NO_ESCALATION' };

      if (voice.attempted) {
        voiceFollowups.push({
          epoch,
          leadId: lead.id,
          leadName: lead.name,
          textChannel: lead.channel,
          voiceStatus: voice.status,
          voiceMode: voice.mode,
          ok: !!voice.ok,
        });
      }

      events.push({
        leadId: lead.id,
        name: lead.name,
        textChannel: lead.channel,
        objectionType: lead.objectionType,
        strategy,
        score: result.score,
        conversionProbability: result.conversionProbability,
        bestCandidateStrategy: bestCandidate?.[0] ?? strategy,
        bestCandidateScore: bestCandidate?.[1]?.score ?? result.score,
        voice,
        evaluator: result.source,
      });

      console.log(
        `${lead.id} | ch=${String(lead.channel).padEnd(12)} | objection=${lead.objectionType.padEnd(10)} | strategy=${strategy.padEnd(12)} | score=${result.score.toFixed(2)} | eval=${String(result.source).padEnd(13)} | best=${String(bestCandidate?.[0] ?? strategy).padEnd(12)} | voice=${voice.attempted ? String(voice.status) : 'skip'}`,
      );
    }

    const epochAvg = Number(average(epochScores).toFixed(3));
    rounds.push({ epoch, avgScore: epochAvg, events });
    console.log(`Epoch ${epoch} avg score: ${epochAvg}`);

    decayExploration(memory);
    memory.runs += 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    epochs,
    rounds,
    finalPolicy: memory.policy,
    strategyStats: memory.strategyStats,
    objectionPolicy: memory.objectionPolicy,
    summary: {
      firstEpochAvg: rounds[0]?.avgScore ?? 0,
      lastEpochAvg: rounds[rounds.length - 1]?.avgScore ?? 0,
      delta: Number(
        ((rounds[rounds.length - 1]?.avgScore ?? 0) - (rounds[0]?.avgScore ?? 0)).toFixed(3),
      ),
    },
    channels: {
      text: TEXT_CHANNELS,
      voiceEnabled: voiceChannelEnabled,
      voiceMode: process.env.VOICE_MODE ?? 'dry-run',
      voiceFollowups,
    },
    evaluator: {
      mode: process.env.EVALUATOR_MODE ?? 'auto',
      model: process.env.EVALUATOR_MODEL ?? 'gpt-4o-mini',
      apiUrl: process.env.EVALUATOR_API_URL ?? 'https://api.openai.com/v1/chat/completions',
    },
  };

  await writeJson(MEMORY_PATH, memory);
  await writeJson(REPORT_PATH, report);

  console.log('\n=== Final Strategy Averages ===');
  for (const strategy of STRATEGIES) {
    const stats = memory.strategyStats[strategy];
    console.log(`${strategy.padEnd(12)} uses=${String(stats.uses).padStart(2)} avg=${stats.avgScore.toFixed(3)}`);
  }

  console.log('\n=== Self-Improvement Summary ===');
  console.log(
    `Average score moved from ${report.summary.firstEpochAvg} to ${report.summary.lastEpochAvg} (delta ${report.summary.delta >= 0 ? '+' : ''}${report.summary.delta}).`,
  );
  console.log(`Updated epsilon (less random over time): ${memory.policy.epsilon}`);
  console.log(`Voice follow-ups triggered: ${voiceFollowups.length}`);
  console.log(`Saved report: ${REPORT_PATH}`);
  console.log('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
