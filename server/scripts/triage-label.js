import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { getAi } from '../src/services/ai/index.js';
import { triageEmail } from '../src/services/triage/classify.js';
import {
  EVAL_SIZE,
  loadCandidates,
  loadEvalLabels,
  pickEvalSet,
  removeEvalLabel,
  saveEvalLabel,
} from '../src/services/triage/evaluation.js';

// Labels received mail by hand for the triage evaluation, one message at a
// time, in the terminal. Picks the messages itself (see pickEvalSet) and
// shows each one as the model reads it, so a label and the model's answer
// are about the same text. Stop any time with q; the next run carries on.
//
//   npm run eval:label --workspace=server
//   npm run eval:label --workspace=server -- --blind
//   npm run eval:label --workspace=server -- --email semab@sift.example --size 50
//
// Seeded mail opens with the bucket the seeder wrote it for already chosen,
// and Enter keeps it. --blind leaves every message unchosen.

const { values: opts } = parseArgs({
  options: {
    email: { type: 'string' },
    size: { type: 'string' },
    blind: { type: 'boolean', default: false },
  },
});

const BUCKETS = [
  ['needs_reply', 'Needs reply', 'the sender is waiting for an answer, given by writing back'],
  ['waiting_on_them', 'Waiting on them', 'the next step is the sender’s; nothing to do but wait'],
  ['do_at_a_time', 'To do', 'something to do other than reply, usually by a date or at a time'],
  ['read_only', 'Read only', 'nothing is asked: newsletters, notifications, receipts, information'],
];
// Picked beyond the size, so a skipped message has one to take its place
// without picking again.
const SPARE = 30;

if (!process.stdin.isTTY) {
  console.error('The labeller reads single keys, so it needs a terminal.');
  process.exit(1);
}

await connectDb();
const ai = getAi();

const users = opts.email ? await User.find({ email: opts.email.toLowerCase() }) : await User.find().limit(2);
if (users.length !== 1) {
  console.error(opts.email ? `No account for ${opts.email}.` : 'There is more than one account. Say which with --email.');
  await disconnectDb();
  process.exit(1);
}
const [user] = users;
const size = Number(opts.size ?? EVAL_SIZE);

console.log('Loading mail…');
const candidates = await loadCandidates(user._id, { ai });
const labels = await loadEvalLabels(user._id);
const counted = () => [...labels.values()].filter((l) => !l.skipped).length;
const skippedCount = () => labels.size - counted();

let queue = [];
function refill() {
  const done = new Map([...labels].map(([id, l]) => [id, l.skipped]));
  queue = pickEvalSet(candidates, { done, size: size + SPARE }).filter((m) => !labels.has(String(m._id)));
}
refill();

// What has been labelled this run, newest last, for undo.
const history = [];
let current = null;
let page = 0;
let showHelp = false;

const wrap = (line, width) => {
  if (line.length <= width) return [line];
  const out = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
};

function render() {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 40;
  const m = current.message;
  const suggestion = opts.blind || current.real ? null : current.seedLabel;
  const shown = triageEmail(m).replace(/^<email>\n/, '').replace(/\n<\/email>$/, '');
  const lines = shown.split('\n').flatMap((line) => wrap(line, width));

  const top = [
    `Triage eval: ${counted()} of ${size} labelled${skippedCount() ? `, ${skippedCount()} skipped` : ''}   (${current.real ? 'real' : 'seeded'} mail)`,
    '─'.repeat(Math.min(width, 80)),
  ];
  const bottom = [
    '─'.repeat(Math.min(width, 80)),
    ...(showHelp ? BUCKETS.map(([, name, what], i) => `${i + 1} ${name}: ${what}`) : []),
    suggestion ? `Seeded as ${BUCKETS.find(([id]) => id === suggestion)[1]}. Enter keeps it.` : '',
    BUCKETS.map(([, name], i) => `${i + 1} ${name}`).join('   '),
    `s skip   u undo   space more   ? help   q quit`,
  ];
  const room = Math.max(5, height - top.length - bottom.length - 1);
  const pages = Math.max(1, Math.ceil(lines.length / room));
  // Past the last page, back to the first.
  if (page >= pages) page = 0;
  const body = lines.slice(page * room, (page + 1) * room);
  if (pages > 1) body.push(`… page ${page + 1} of ${pages}, space for more`);

  process.stdout.write('\x1b[2J\x1b[H' + [...top, ...body, ...bottom].join('\n'));
}

async function next() {
  if (counted() >= size) return finish(`All ${size} labelled.`);
  if (queue.length === 0) refill();
  if (queue.length === 0) return finish('No more mail fits the set.');
  current = queue.shift();
  page = 0;
  render();
}

async function answer(label) {
  await saveEvalLabel(user._id, current._id, label);
  labels.set(String(current._id), { label, skipped: label === null });
  history.push(current);
  await next();
}

async function undo() {
  const last = history.pop();
  if (!last) return render();
  await removeEvalLabel(last._id);
  labels.delete(String(last._id));
  queue.unshift(current);
  current = last;
  page = 0;
  render();
}

async function finish(why) {
  process.stdin.setRawMode(false);
  process.stdout.write('\x1b[2J\x1b[H');
  const byBucket = BUCKETS.map(([id, name]) => `${name} ${[...labels.values()].filter((l) => l.label === id).length}`);
  console.log(`${why}\n${counted()} labelled (${byBucket.join(', ')}), ${skippedCount()} skipped.`);
  if (counted() > 0) console.log('Score the model on them with: npm run eval:triage --workspace=server');
  await disconnectDb();
  process.exit(0);
}

let busy = false;
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on('keypress', async (text, key = {}) => {
  if (busy) return;
  busy = true;
  try {
    if (key.ctrl && key.name === 'c') return await finish('Stopped.');
    if (key.name === 'q') return await finish('Stopped. Run it again to carry on.');
    if (['1', '2', '3', '4'].includes(text)) return await answer(BUCKETS[Number(text) - 1][0]);
    if (key.name === 'return' && !opts.blind && !current.real && current.seedLabel) return await answer(current.seedLabel);
    if (key.name === 's') return await answer(null);
    if (key.name === 'u') return await undo();
    if (key.name === 'space') page += 1;
    if (text === '?') showHelp = !showHelp;
    render();
  } finally {
    busy = false;
  }
});

await next();
