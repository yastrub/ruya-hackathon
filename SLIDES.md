# Slide 1 (Max 2 slides format)

## Self-Improving Sales Closer Agent

- Learns from scored lead interactions
- Adapts strategy per objection type
- Optimizes over time via exploration decay
- Orchestrates channels: text first, voice escalation for high-friction leads

Loop: **Signal -> Score -> Memory -> Policy Update -> Better Next Response**

# Slide 2

## Live Demo Outcome

- Round 1 average quality: 7.417
- Round 2 average quality: 7.817
- Improvement delta: +0.400

Plus:
- objection-specific strategy map learned
- lower randomness over time (epsilon decay)
- automatic text -> voice escalation events (SIMULATED / LIVE)
- reproducible from CLI in under 1 minute

Demo command:

`pnpm --filter @tatiana/ruya-hackathon reset && pnpm --filter @tatiana/ruya-hackathon demo:multichannel`
