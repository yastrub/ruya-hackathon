# Ruya Hackathon: Self-Improving Sales Closer Agent

A fast, demo-ready hackathon project that demonstrates a **self-improving AI agent loop** for sales conversations across two channels:

- Text channel: Instagram DM + WhatsApp
- Voice channel: ElevenLabs Agents API outbound calls via Twilio

## What this agent does

The agent handles inbound leads with objections and continuously improves strategy quality over repeated rounds.

It explicitly demonstrates:

- **Learn**: stores scored outcomes of each strategy per objection type
- **Adapt**: updates objection-specific policy (`objectionPolicy`) based on outcomes
- **Optimize**: gradually reduces exploration randomness (`epsilon` decay) and converges toward stronger strategies
- **Orchestrate channels**: escalates selected leads from text to voice follow-up in later epochs

## Why this fits the challenge

The hackathon asks for self-improving agents that can:

1. Learn from data and feedback
2. Adapt strategies over time
3. Optimize behaviors autonomously

This project implements all three with a clear, inspectable memory loop.

## Run locally

From repository root:

```bash
pnpm --filter @tatiana/ruya-hackathon demo
```

## Judge self-test (copy-paste)

From repository root:

```bash
pnpm --filter @tatiana/ruya-hackathon judge:test
```

Secure variant (signature verification ON):

```bash
pnpm --filter @tatiana/ruya-hackathon judge:test:secure
```

Expected proof markers in terminal output:

- `Epoch 1 avg score: 7.417`
- `Epoch 2 avg score: 7.817`
- `voice=SIMULATED` and `Voice follow-ups triggered: 6`
- `Status: 200` for webhook replay
- secure mode: `Signature verification: enabled`

Optional controls:

```bash
pnpm --filter @tatiana/ruya-hackathon demo -- --epochs=3 --warmupEpochs=1
pnpm --filter @tatiana/ruya-hackathon demo -- --epochs=3 --warmupEpochs=1 --voice=on --voiceFromEpoch=2
pnpm --filter @tatiana/ruya-hackathon reset
```

One-command multichannel demo:

```bash
pnpm --filter @tatiana/ruya-hackathon demo:multichannel
```

Recommended judge-flow command sequence:

```bash
pnpm --filter @tatiana/ruya-hackathon reset
pnpm --filter @tatiana/ruya-hackathon demo -- --epochs=3 --warmupEpochs=1 --voice=on --voiceFromEpoch=2
```

## ElevenLabs voice configuration

By default voice calls run in `dry-run` mode (safe for judging and no accidental calls).

To enable live calls, set env vars before running:

```bash
export VOICE_MODE=live
export ELEVENLABS_API_KEY="xi_..."
export ELEVENLABS_AGENT_ID="agent_..."
export ELEVENLABS_AGENT_PHONE_NUMBER_ID="pn_..."
```

Optional variables:

- `ELEVENLABS_OUTBOUND_CALL_URL` (default: `https://api.elevenlabs.io/v1/convai/twilio/outbound-call`)
- `ELEVENLABS_LANGUAGE` (default: `en`)
- `ELEVENLABS_DYNAMIC_VARIABLES_JSON` (JSON map)
- `ELEVENLABS_CONVERSATION_INIT_JSON` (JSON object)

Reference template: `voice.config.example.json`

## LLM-based evaluator (with rule fallback)

The scoring engine now supports an LLM judge and falls back to rule-based scoring if LLM is unavailable.

Modes:

- `EVALUATOR_MODE=auto` (default): use LLM if `EVALUATOR_API_KEY` is set, else use rules
- `EVALUATOR_MODE=llm`: force LLM evaluation
- `EVALUATOR_MODE=rule`: force rule-based evaluation

Evaluator env vars:

- `EVALUATOR_API_KEY` (required for LLM)
- `EVALUATOR_API_URL` (default: OpenAI chat completions URL)
- `EVALUATOR_MODEL` (default: `gpt-4o-mini`)
- `EVALUATOR_TIMEOUT_MS` (default: `12000`)

## Post-call webhook stub (duration + transcript)

This project includes a local webhook endpoint to ingest ElevenLabs `post_call_transcription` events and extract learning signals.

Start listener:

```bash
pnpm --filter @tatiana/ruya-hackathon webhook:listen
```

Replay bundled sample event:

```bash
pnpm --filter @tatiana/ruya-hackathon webhook:replay
```

Webhook path:

- `POST /webhooks/elevenlabs`

Signature verification (production-style):

- Set `ELEVENLABS_WEBHOOK_SECRET` to require HMAC verification on incoming webhooks.
- Optional: `ELEVENLABS_WEBHOOK_TOLERANCE_SECONDS` (default `300`) for timestamp drift checks.
- `webhook:replay` automatically signs payloads when `ELEVENLABS_WEBHOOK_SECRET` is present.

Generated artifacts:

- `data/post-call-latest.json` (last event + parsed summary)
- `data/post-call-events.ndjson` (append-only event log)
- `data/post-call-learning.json` (aggregated learning stats by lead)

Parsed signals include:

- `durationSeconds`
- `transcriptTurns`, `userTurns`, `agentTurns`
- `leadId` (from dynamic variables when present)
- `transcriptPreview` for fast inspection

## Project structure

- `src/run.mjs` - main self-improving loop and scoring
- `src/elevenlabs-outbound.mjs` - ElevenLabs outbound call adapter
- `src/webhook-server.mjs` - local post-call transcription webhook receiver
- `src/replay-webhook.mjs` - sends sample webhook payload to local receiver
- `src/reset.mjs` - reset memory to initial state
- `data/leads.json` - synthetic lead inputs
- `data/memory.json` - persistent agent memory and policy
- `data/report-latest.json` - generated report after each run
- `data/sample-post-call-webhook.json` - sample post-call event payload

## 3-minute demo script

1. Run the demo with 2 or 3 epochs.
2. Show that epoch 1 explores, while later epochs exploit learned policy.
3. Show epoch outputs and average score improvement.
4. Open `data/report-latest.json` and highlight:
   - `summary.delta` (quality improvement)
   - updated `objectionPolicy`
   - reduced `epsilon` in `finalPolicy`
   - `channels.voiceFollowups` (text -> voice escalation evidence)
5. (Q&A) Show post-call learning evidence via `post-call-learning.json`.
6. Explain the self-improvement loop:
   - Feedback score -> memory update -> strategy policy update -> better future response

## Notes

- No external API keys required.
- Deterministic scaffolding with adaptive policy logic for reliable hackathon demo.
- Designed for speed and judging clarity.
