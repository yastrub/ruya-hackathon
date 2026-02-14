import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');

const INITIAL_MEMORY = {
  runs: 0,
  policy: {
    epsilon: 0.45,
    decay: 0.7,
    minEpsilon: 0.05,
  },
  strategyStats: {
    consultative: { uses: 0, totalScore: 0, avgScore: 0 },
    social_proof: { uses: 0, totalScore: 0, avgScore: 0 },
    urgent_offer: { uses: 0, totalScore: 0, avgScore: 0 },
  },
  objectionPolicy: {},
  history: [],
};

async function main() {
  await fs.writeFile(MEMORY_PATH, JSON.stringify(INITIAL_MEMORY, null, 2) + '\n', 'utf-8');
  console.log(`Reset memory at: ${MEMORY_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
