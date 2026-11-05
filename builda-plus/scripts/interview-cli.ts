// Try the interview in a terminal on your OpenAI key:
//   cp .env.example .env   (fill in OPENAI_API_KEY and OPENAI_MODEL)
//   npm run interview -- --role case_manager
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROLES, type Role } from '../src/domain/journey';
import { OpenAIProvider } from '../src/llm/openai';
import { BudgetedProvider, InMemoryUsageLedger } from '../src/llm/budget';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';
import { startInterview, handleParticipantMessage, pauseInterview } from '../src/interview/orchestrator';
import { assessConfidence } from '../src/engine/confidence';

const roleArg = process.argv[process.argv.indexOf('--role') + 1] as Role | undefined;
const role: Role = roleArg && (ROLES as readonly string[]).includes(roleArg) ? roleArg : 'case_manager';

const ledger = new InMemoryUsageLedger();
const llm = new BudgetedProvider(new OpenAIProvider(), ledger, {
  discoveryId: 'demo', maxTokensPerDiscovery: Number(process.env.MAX_TOKENS_PER_DISCOVERY ?? 300_000),
});

const rl = readline.createInterface({ input: stdin, output: stdout });
let { state, reply } = startInterview({ discoveryId: 'demo', participantRef: 'P1', role });
console.log(`\n[builda+ interview — role: ${role}. Type /pause to pause, /quit to stop]\n`);

while (state.status === 'in_progress') {
  console.log(`\nInterviewer: ${reply}\n`);
  const input = (await rl.question('You: ')).trim();
  if (!input) continue;
  if (input === '/quit') break;
  if (input === '/pause') { state = pauseInterview(state); console.log('\n(paused — state could now be saved and resumed later)'); break; }
  const out = await handleParticipantMessage(state, input, { llm, playbook: SEED_PLAYBOOK });
  for (const e of out.events) console.log(`  · ${JSON.stringify(e)}`);
  state = out.state; reply = out.reply;
}
if (state.status !== 'in_progress' && state.status !== 'paused') console.log(`\nInterviewer: ${reply}`);
rl.close();

console.log(`\n=== Session ${state.status} — ${state.evidence.length} evidence records, ${state.droppedEvidenceCount} dropped (unverified quotes) ===`);
const byKey = Object.groupBy(state.evidence, (e) => e.painPointKey);
for (const [key, recs] of Object.entries(byKey)) {
  const c = assessConfidence(recs!);
  console.log(`\n${key}  [confidence: ${c.level}]`);
  for (const r of recs!) console.log(`  - ${r.stageId}: ${r.taskDescription} | vol/month=${r.monthlyVolume ?? '?'} | mins=${r.minutesPerOccurrence ?? '?'} | "${r.supportingQuote}"`);
}
const tokens = await ledger.spentTokens('demo');
console.log(`\nAI usage: ${tokens} tokens across ${ledger.entries.length} calls`);
