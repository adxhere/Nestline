// Nestline: AI savings agent on the PayPal sandbox. No dependencies, needs Node 20.12+.
const http = require('http');
const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* no .env yet */ }

const PORT = process.env.PORT || 3000;
const CUR = process.env.CURRENCY || 'USD';
const PP = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
// First model is the main one; GEMINI_FALLBACK_MODELS (comma separated) are tried if it stays busy.
const GEMINI_MODELS = [process.env.GEMINI_MODEL || 'gemini-3.8-flash']
  .concat((process.env.GEMINI_FALLBACK_MODELS || '').split(',').map(x => x.trim()).filter(Boolean));
const DB = path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- state ----------
const fresh = () => ({ month: new Date().toISOString().slice(0, 7), budget: 0, goals: [], log: [], chat: [], history: [], deposits: [] });
function load() {
  let s; try { s = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) { s = fresh(); }
  for (const k of ['goals', 'log', 'chat', 'history', 'deposits']) if (!Array.isArray(s[k])) s[k] = [];
  return s;
}
// Every save records how much is held in goals this month, for the savings chart.
function save(s) {
  const held = s.goals.reduce((a, g) => a + (g.paid ? 0 : g.saved), 0);
  const last = s.history[s.history.length - 1];
  if (last && last.month === s.month) last.total = held; else s.history.push({ month: s.month, total: held });
  s.history = s.history.slice(-24);
  fs.writeFileSync(DB, JSON.stringify(s, null, 2));
}
function deposit(s, g, amount, via) {
  s.deposits.unshift({ month: s.month, goal: g.name, amount, via });
  s.deposits = s.deposits.slice(0, 50);
}
function note(s, text) { s.log.unshift({ month: s.month, text }); s.log = s.log.slice(0, 60); }

// ---------- money maths (plain code, never the model) ----------
const RANK = { fixed: 0, movable: 1, flexible: 2 };
function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
function addMonths(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function plan(s) {
  const active = s.goals.filter(g => !g.paid);
  const ordered = [...active].sort((a, b) => (RANK[a.flex] - RANK[b.flex]) || a.deadline.localeCompare(b.deadline));
  let pool = s.budget, needTotal = 0;
  const items = ordered.map((g, i) => {
    const remaining = Math.max(0, g.target - g.saved);
    const gap = monthsBetween(s.month, g.deadline);
    const left = Math.max(1, gap);
    const need = remaining === 0 ? 0 : Math.ceil(remaining / left);
    const alloc = Math.min(need, pool);
    pool -= alloc; needTotal += need;
    let status = 'on track', finish = g.deadline;
    if (remaining === 0) status = 'funded';
    else if (gap < 0) status = 'overdue';
    else if (!s.budget) status = 'unplanned';
    else if (alloc < need) {
      status = 'behind';
      finish = alloc > 0 ? addMonths(s.month, Math.ceil(remaining / alloc)) : null;
    }
    return { id: g.id, priority: i + 1, remaining, monthsLeft: left, need, alloc, status, finish };
  });
  return { items, needTotal, spare: pool, shortfall: Math.max(0, needTotal - s.budget) };
}
function view(s) {
  return {
    state: s, plan: plan(s), currency: CUR,
    config: { paypalClientId: process.env.PAYPAL_CLIENT_ID || '', aiReady: !!process.env.GEMINI_API_KEY }
  };
}
const newId = () => 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
function findGoal(s, ref) {
  if (!ref) return null;
  const r = String(ref).toLowerCase();
  return s.goals.find(g => g.id === ref) || s.goals.find(g => g.name.toLowerCase() === r) || s.goals.find(g => g.name.toLowerCase().includes(r));
}

// ---------- AI agent (Gemini) ----------
const AGENT_RULES = `You are Nestline, a savings agent. The user saves toward several goals from one monthly budget.
You understand goals written in plain language, judge how fixed each deadline is, propose trade-offs and explain the plan.
You never do arithmetic on allocations yourself: the app computes the plan and gives it to you in "plan". Quote its numbers.
Reply ONLY with JSON: {"reply": string, "actions": Action[]}.
Actions (use only when the user asks for or agrees to the change):
 {"type":"add_goal","name":string,"target":number,"deadline":"YYYY-MM","flex":"fixed"|"movable"|"flexible","merchant":string}
 {"type":"set_budget","amount":number}
 {"type":"move_deadline","goal":string,"deadline":"YYYY-MM"}
 {"type":"change_target","goal":string,"target":number}
 {"type":"set_monthly","goal":string,"amount":number}   // optional automatic monthly contribution; 0 turns it off
 {"type":"remove_goal","goal":string}
Rules:
- flex: "fixed" for dates that cannot move (fees, rent, exams), "movable" for purchases that could slip a few months, "flexible" for wants like trips.
- If the user gives no amount for a goal, estimate a sensible one and say it is an estimate they can change.
- Deadlines must be after the current month. "by March" means the next March.
- A monthly plan is optional. Suggest it, never insist. The user can always add money whenever they want.
- If plan.shortfall > 0, name the goals, then offer two concrete choices (for example move a movable goal later, or lower a flexible target). Fixed goals are protected first.
- Keep "reply" under 90 words, plain sentences, no markdown. Amounts are in ${CUR}.`;

let modelList = null;
async function otherModels(key) {
  if (modelList) return modelList;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    modelList = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && /flash/.test(n) && !/(image|tts|audio|live|embedding|native)/.test(n))
      .sort().reverse();
  } catch (e) { modelList = []; }
  return modelList;
}

async function askAgent(s, message) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing in .env');
  const context = {
    currentMonth: s.month, monthlyBudget: s.budget, currency: CUR,
    goals: s.goals.map(g => ({ name: g.name, target: g.target, saved: g.saved, deadline: g.deadline, flex: g.flex, monthly: g.monthly, paid: !!g.paid })),
    plan: plan(s)
  };
  const history = s.chat.slice(-8).map(m => ({ role: m.who === 'you' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const body = {
    systemInstruction: { parts: [{ text: AGENT_RULES }] },
    contents: [...history, { role: 'user', parts: [{ text: `App data: ${JSON.stringify(context)}\n\nUser says: ${message}` }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
  };
  // The AI service is sometimes busy. Try the configured model twice, then any other Flash model this key can use.
  const queue = [...GEMINI_MODELS], tried = [];
  let r, j, firstError = null, discovered = false;
  while (queue.length && tried.length < 6) {
    const model = queue.shift();
    if (tried.includes(model)) continue;
    tried.push(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body), signal: AbortSignal.timeout(25000)
        });
        j = await r.json().catch(() => ({}));
      } catch (e) { r = { ok: false, status: 599 }; j = { error: { message: 'no answer from ' + model + ' (' + e.message + ')' } }; }
      if (r.ok) break;
      if (!firstError) firstError = (j.error && j.error.message) || String(r.status);
      console.log(`AI: ${model} failed (${r.status}): ${(j.error && j.error.message || '').slice(0, 120)}`);
      if (r.status !== 429 && r.status < 500) break;   // not a "busy" error: retrying this model will not help
      await new Promise(done => setTimeout(done, 1500));
    }
    if (r.ok) { console.log('AI: answered by ' + model); break; }
    if (!queue.length && !discovered) { discovered = true; queue.push(...await otherModels(key)); }
  }
  if (!r.ok) throw new Error('AI error: ' + firstError + ' (tried ' + tried.join(', ') + ')');
  const cand = j.candidates && j.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!parts) throw new Error('The AI returned no answer. Try rephrasing.');
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
  let out; try { out = JSON.parse(text); } catch (e) { out = { reply: text, actions: [] }; }
  return { reply: String(out.reply || ''), actions: Array.isArray(out.actions) ? out.actions : [] };
}
const validMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function future(s, m) { while (m <= s.month) m = addMonths(m, 12); return m; }
function applyActions(s, actions) {
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const g = findGoal(s, a.goal);
    if (validMonth(a.deadline)) a.deadline = future(s, a.deadline);
    if (a.target !== undefined) a.target = Number(a.target);
    if (a.amount !== undefined) a.amount = Number(a.amount);
    const same = a.type === 'add_goal' && a.name && s.goals.find(x => !x.paid && x.name.trim().toLowerCase() === String(a.name).trim().toLowerCase());
    if (same && a.target > 0 && validMonth(a.deadline)) {
      same.target = Math.round(a.target); same.deadline = a.deadline;
      if (RANK[a.flex] !== undefined) same.flex = a.flex;
      note(s, `Goal "${same.name}" updated (${same.target} ${CUR} by ${same.deadline}).`);
    } else if (a.type === 'add_goal' && a.name && a.target > 0 && validMonth(a.deadline)) {
      s.goals.push({ id: newId(), name: String(a.name).slice(0, 60), target: Math.round(a.target), saved: 0, deadline: a.deadline, flex: RANK[a.flex] !== undefined ? a.flex : 'flexible', monthly: 0, merchant: String(a.merchant || a.name).slice(0, 60), paid: false });
      note(s, `Agent added goal "${a.name}" (${a.target} ${CUR} by ${a.deadline}, ${a.flex}).`);
    } else if (a.type === 'set_budget' && a.amount >= 0) {
      s.budget = Math.round(a.amount); note(s, `Monthly budget set to ${s.budget} ${CUR}.`);
    } else if (a.type === 'move_deadline' && g && validMonth(a.deadline)) {
      note(s, `Agent moved "${g.name}" from ${g.deadline} to ${a.deadline}.`); g.deadline = a.deadline;
    } else if (a.type === 'change_target' && g && a.target > 0) {
      note(s, `Agent changed "${g.name}" target from ${g.target} to ${Math.round(a.target)} ${CUR}.`); g.target = Math.round(a.target);
    } else if (a.type === 'set_monthly' && g && a.amount >= 0) {
      g.monthly = Math.round(a.amount); note(s, g.monthly ? `Monthly plan of ${g.monthly} ${CUR} set for "${g.name}".` : `Monthly plan stopped for "${g.name}".`);
    } else if (a.type === 'remove_goal' && g) {
      s.goals = s.goals.filter(x => x !== g); note(s, `Goal "${g.name}" removed.`);
    }
  }
}

// ---------- PayPal sandbox ----------
async function ppToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing in .env');
  const r = await fetch(PP + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal login failed: ' + (j.error_description || r.status));
  return j.access_token;
}
async function pp(method, url, body) {
  const token = await ppToken();
  const r = await fetch(PP + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal: ' + (j.message || (j.details && j.details[0] && j.details[0].description) || r.status));
  return j;
}

// ---------- routes ----------
const paying = new Set();
const routes = {
  'GET /api/state': async () => view(load()),

  'POST /api/chat': async (b) => {
    const s = load(); const message = String(b.message || '').slice(0, 800);
    if (!message) throw new Error('Empty message');
    const out = await askAgent(s, message);
    s.chat.push({ who: 'you', text: message });
    applyActions(s, out.actions);
    s.chat.push({ who: 'agent', text: out.reply || 'Done.' });
    s.chat = s.chat.slice(-40); save(s); return view(s);
  },

  // Top-up step 1: create a PayPal order for the amount.
  'POST /api/paypal/order': async (b) => {
    const s = load(); const g = findGoal(s, b.goalId); const amount = Math.round(Number(b.amount));
    if (!g) throw new Error('Choose a goal first');
    if (g.paid) throw new Error('This goal is already paid');
    if (!(amount >= 1)) throw new Error('Enter an amount of at least 1');
    const room = g.target - g.saved;
    if (room <= 0) throw new Error('This goal is already fully funded');
    if (amount > room) throw new Error(`"${g.name}" only needs ${room} ${CUR} more`);
    const order = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: g.id, description: ('Nestline top-up: ' + g.name).slice(0, 120), amount: { currency_code: CUR, value: amount.toFixed(2) } }]
    });
    return { id: order.id };
  },

  // Top-up step 2: capture after the buyer approves, then credit the goal.
  'POST /api/paypal/capture': async (b) => {
    const cap = await pp('POST', `/v2/checkout/orders/${encodeURIComponent(b.orderID)}/capture`, {});
    const c = cap.purchase_units[0].payments.captures[0];
    if (c.status !== 'COMPLETED') throw new Error('Payment status: ' + c.status);
    const s = load(); const g = findGoal(s, c.custom_id) || findGoal(s, b.goalId);
    if (!g) throw new Error('Payment captured (' + c.id + ') but the goal no longer exists');
    const before = plan(s).items.find(i => i.id === g.id);
    const paid = Math.round(Number(c.amount.value));
    g.saved = Math.min(g.target, g.saved + paid);
    deposit(s, g, paid, 'PayPal');
    const after = plan(s).items.find(i => i.id === g.id);
    let why = after.status === 'funded' ? 'The goal is fully funded.' : `It now needs ${after.need} ${CUR} a month instead of ${before.need}.`;
    note(s, `Top-up of ${paid} ${CUR} to "${g.name}" via PayPal (capture ${c.id}). ${why}`);
    save(s); return view(s);
  },

  // Manual path: add a goal or set the budget without the agent (useful when the AI service is busy).
  'POST /api/goal': async (b) => {
    const s = load(); const before = s.log[0];
    applyActions(s, [{ type: 'add_goal', name: String(b.name || '').trim(), target: b.target, deadline: b.deadline, flex: b.flex, merchant: b.merchant }]);
    if (s.log[0] === before) throw new Error('Enter a name, an amount above 0 and a month');
    save(s); return view(s);
  },
  'POST /api/budget': async (b) => {
    const s = load(); if (!(Number(b.amount) >= 0)) throw new Error('Enter a budget of 0 or more');
    applyActions(s, [{ type: 'set_budget', amount: b.amount }]); save(s); return view(s);
  },
  'POST /api/sample': async () => {
    const s = fresh();
    applyActions(s, [
      { type: 'set_budget', amount: 400 },
      { type: 'add_goal', name: 'Laptop', target: 900, deadline: addMonths(s.month, 4), flex: 'movable', merchant: 'Laptop store' },
      { type: 'add_goal', name: "Sister's college fees", target: 1400, deadline: addMonths(s.month, 7), flex: 'fixed', merchant: 'Northfield College' },
      { type: 'add_goal', name: 'Goa trip', target: 600, deadline: addMonths(s.month, 13), flex: 'flexible', merchant: 'Travel agency' }
    ]);
    note(s, 'Sample goals loaded (example data).');
    save(s); return view(s);
  },

  // Turn the agent's plan into monthly plans for every unfunded goal.
  'POST /api/apply-plan': async () => {
    const s = load(); const p = plan(s);
    if (!s.budget) throw new Error('Set a monthly budget first');
    const set = [];
    for (const i of p.items) {
      const g = s.goals.find(x => x.id === i.id);
      if (i.status === 'funded' || !i.alloc) continue;
      g.monthly = i.alloc; set.push(`"${g.name}" ${i.alloc}`);
    }
    if (!set.length) throw new Error('Nothing to plan: every goal is funded or the budget is used up');
    note(s, `Agent's plan applied as monthly plans (${CUR}): ${set.join(', ')}.`);
    save(s); return view(s);
  },

  'POST /api/monthly': async (b) => {
    const s = load(); const g = findGoal(s, b.goalId); if (!g) throw new Error('Goal not found');
    applyActions(s, [{ type: 'set_monthly', goal: g.id, amount: Number(b.amount) || 0 }]); save(s); return view(s);
  },

  // Demo clock: move one month ahead. Monthly plans pay in unless the month is skipped.
  'POST /api/next-month': async (b) => {
    const s = load(); const before = plan(s); const lines = [];
    for (const g of s.goals) {
      if (g.paid || !g.monthly || g.saved >= g.target) continue;
      if (b.skip) { lines.push(`"${g.name}" missed its ${g.monthly} ${CUR}`); continue; }
      const add = Math.min(g.monthly, g.target - g.saved); g.saved += add; deposit(s, g, add, 'Monthly plan (simulated)'); lines.push(`"${g.name}" +${add} ${CUR}`);
    }
    s.month = addMonths(s.month, 1);
    const after = plan(s);
    const changes = after.items.map(i => {
      const was = before.items.find(x => x.id === i.id), g = s.goals.find(x => x.id === i.id);
      if (!was || i.status === 'funded') return null;
      if (i.need > was.need) return `"${g.name}" now needs ${i.need} ${CUR} a month (was ${was.need}) because there is one month less`;
      if (i.status === 'behind' && was.status !== 'behind') return `"${g.name}" fell behind`;
      return null;
    }).filter(Boolean);
    note(s, `${b.skip ? 'Skipped month' : 'Month closed'} (simulated). ${lines.join(', ') || 'No monthly plans ran'}. ${changes.length ? 'Rebalanced: ' + changes.join('; ') + '.' : 'Plan unchanged.'}`);
    save(s); return view(s);
  },

  // Agent pays the merchant once the goal is funded and the user approves.
  'POST /api/payout': async (b) => {
    const s = load(); const g = findGoal(s, b.goalId); if (!g) throw new Error('Goal not found');
    if (g.paid) throw new Error('Already paid');
    if (paying.has(g.id)) throw new Error('This payment is already in progress');
    if (g.saved < g.target) throw new Error('Goal is not fully funded yet');
    const receiver = process.env.MERCHANT_EMAIL;
    if (!receiver) throw new Error('MERCHANT_EMAIL is missing in .env (use a sandbox account email)');
    paying.add(g.id);
    let out;
    try { out = await pp('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: 'nestline_' + g.id + '_' + Date.now(), email_subject: 'Payment from Nestline', email_message: 'Goal payment: ' + g.name },
      items: [{ recipient_type: 'EMAIL', receiver, amount: { value: g.target.toFixed(2), currency: CUR }, note: 'Goal payment: ' + g.name, sender_item_id: g.id }]
    }); } finally { paying.delete(g.id); }
    g.paid = true; g.payoutId = out.batch_header.payout_batch_id;
    note(s, `You approved. Agent paid ${g.target} ${CUR} to ${g.merchant} via PayPal Payouts (batch ${g.payoutId}).`);
    save(s); return view(s);
  },

  'POST /api/reset': async () => { const s = fresh(); save(s); return view(s); }
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = routes[req.method + ' ' + url.pathname];
  if (handler) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
    try {
      const out = await handler(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname === '/app' ? '/app.html' : url.pathname;
  file = path.join(PUBLIC, path.normalize(file));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Close the other program or set PORT in .env.` : e.message);
  process.exit(1);
}).listen(PORT, () => console.log(`Nestline running at http://localhost:${PORT}`));
