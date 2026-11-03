// Gen-10 Phase A4: public governance watcher. On-chain reads ONLY (no database, no backend), one process, no
// secrets except the optional Discord webhook URL.
//
// What it does, every WATCH_INTERVAL_S (default 300 s) or once with --once:
//   1. loads the factory records (default contracts/deployments/gen9-factories.json and, when present,
//      gen10-factories.json; override with FACTORY_RECORDS=path,path),
//   2. reads every factory's governance state: owner, pendingOwner + ownershipEffectiveAt, operator,
//      pendingOperator, guardian, pendingGuardian, approvers + approvalsRequired + approverEpoch, pendingApprovers,
//      treasury (+ pendingTreasury on gen-9; immutable on gen-10), minApprovalsRequired (gen-10), paused,
//      refundTimeout, looseningEffectiveAt, creationUnlockAt, version,
//   3. writes STATE_DIR/governance.json (the public page reads this: instaswap.com/security/governance) and
//      STATE_DIR/last.json (previous snapshot for the diff),
//   4. posts every change to the Discord webhook (DISCORD_WEBHOOK_URL): a new schedule with its countdown, a cancel,
//      an execution, pause / unpause, ownership transfer started / accepted, and a daily "open schedules" digest
//      (DIGEST_HOUR_UTC, default 9) while anything is pending.
//
// Reads go through Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) when it has code on the chain, else one
// eth_call per field. A field a generation lacks (pendingTreasury on gen-10, minApprovalsRequired on gen-9) is
// recorded as null, never as an error. An RPC failure keeps the last known state of that chain and is flagged in
// the JSON (`chains[].error`) so a stale page is visible as stale.
//
// Env: DISCORD_WEBHOOK_URL (optional; without it the watcher only writes the JSON), STATE_DIR (default ./state),
// WATCH_INTERVAL_S, <SUFFIX>_RPC_URL per chain (defaults below are public RPCs), FACTORY_RECORDS, DIGEST_HOUR_UTC,
// PUBLIC_URL (printed in messages, e.g. https://instaswap.com/security/governance).
// Run: node watcher.mjs --once | node watcher.mjs   (systemd / pm2 / GitHub Actions cron, see README.md)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const STATE_DIR = process.env.STATE_DIR || path.join(here, 'state');
const ONCE = process.argv.includes('--once');
const INTERVAL_MS = Math.max(60, Number(process.env.WATCH_INTERVAL_S || 300)) * 1000;
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
// Telegram public channel: bot token + channel id ("@channelname" or "-100..."); the bot must be a channel admin.
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();
const SINKS = [WEBHOOK ? 'discord' : null, TG_TOKEN && TG_CHAT ? 'telegram' : null].filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://instaswap.com/security/governance').trim();
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR_UTC ?? 9);
const RPC_TIMEOUT_MS = 20_000;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const CHAINS = {
  mainnet:    { chainId: 1,       label: 'Ethereum',        suffix: 'ETH',        rpc: 'https://ethereum-rpc.publicnode.com' },
  optimism:   { chainId: 10,      label: 'Optimism',        suffix: 'OPTIMISM',   rpc: 'https://mainnet.optimism.io' },
  bnb:        { chainId: 56,      label: 'BNB Chain',       suffix: 'BSC',        rpc: 'https://bsc-dataseed.binance.org' },
  unichain:   { chainId: 130,     label: 'Unichain',        suffix: 'UNICHAIN',   rpc: 'https://unichain-rpc.publicnode.com' },
  polygon:    { chainId: 137,     label: 'Polygon',         suffix: 'POLYGON',    rpc: 'https://polygon-bor-rpc.publicnode.com' },
  worldchain: { chainId: 480,     label: 'World Chain',     suffix: 'WORLDCHAIN', rpc: 'https://worldchain-mainnet.g.alchemy.com/public' },
  robinhood:  { chainId: 4663,    label: 'Robinhood Chain', suffix: 'ROBINHOOD',  rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  arc:        { chainId: 5042,    label: 'Arc',             suffix: 'ARC',        rpc: '' },
  zora:       { chainId: 7777777, label: 'Zora',            suffix: 'ZORA',       rpc: 'https://rpc.zora.energy' },
  base:       { chainId: 8453,    label: 'Base',            suffix: 'BASE',       rpc: 'https://mainnet.base.org' },
  arbitrum:   { chainId: 42161,   label: 'Arbitrum One',    suffix: 'ARBITRUM',   rpc: 'https://arb1.arbitrum.io/rpc' },
  avalanche:  { chainId: 43114,   label: 'Avalanche',       suffix: 'AVALANCHE',  rpc: 'https://api.avax.network/ext/bc/C/rpc' },
  blast:      { chainId: 81457,   label: 'Blast',           suffix: 'BLAST',      rpc: 'https://rpc.blast.io' },
};
for (const c of Object.values(CHAINS)) c.rpc = (process.env[`${c.suffix}_RPC_URL`] || c.rpc || '').trim();
// Arc has no public RPC: on the owner's workstation take it from the gitignored deploy config (only that field).
if (!CHAINS.arc.rpc) { try { CHAINS.arc.rpc = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'local', 'deploy-config.json'), 'utf8')).arcRpcUrl || '').trim(); } catch { /* server: ARC_RPC_URL env */ } }

// Governance surface shared by gen-9 and gen-10 (FactoryGovernance + ApproverRegistryV2); optional per generation.
const ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function ownershipEffectiveAt() view returns (uint64)',
  'function operator() view returns (address)',
  'function pendingOperator() view returns (address operator, uint64 effectiveAt)',
  'function guardian() view returns (address)',
  'function pendingGuardian() view returns (address guardian, uint64 effectiveAt)',
  'function approvers() view returns (address[])',
  'function approvalsRequired() view returns (uint256)',
  'function approverEpoch() view returns (uint256)',
  'function pendingApprovers() view returns (address[] approversList, uint256 required, uint256 effectiveAt)',
  'function treasury() view returns (address)',
  'function pendingTreasury() view returns (address treasury, uint64 effectiveAt)',   // gen-9 only
  'function minApprovalsRequired() view returns (uint256)',                            // gen-10 only
  'function paused() view returns (bool)',
  'function refundTimeout() view returns (uint256)',
  'function looseningEffectiveAt() view returns (uint256)',
  'function creationUnlockAt() view returns (uint256)',
  'function version() view returns (string)',
];
const OPTIONAL = new Set(['pendingTreasury', 'minApprovalsRequired']);
const FIELDS = ABI.map((s) => s.match(/function (\w+)/)[1]);
const iface = new ethers.Interface(ABI);
const MC_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])'];

// ── factories ─────────────────────────────────────────────────────────────────────────────────────────────────────
function loadFactories() {
  const files = (process.env.FACTORY_RECORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // monorepo: the deploy records next to the contracts; standalone public repo: copies under ./records
  const dirs = [path.join(ROOT, 'contracts', 'deployments'), path.join(here, 'records')];
  if (!files.length) for (const dir of dirs) { for (const g of ['gen9', 'gen10']) { const f = path.join(dir, `${g}-factories.json`); if (fs.existsSync(f)) files.push(f); } if (files.length) break; }
  const out = [];
  for (const f of files) {
    const gen = path.basename(f).replace('-factories.json', '');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [chainKey, tags] of Object.entries(rec)) for (const [tag, r] of Object.entries(tags)) {
      if (!r?.address || !r?.chainId) continue;
      out.push({ id: `${gen}:${chainKey}:${tag}`, gen, chainKey, chainId: Number(r.chainId), tag, contract: r.contract, address: ethers.getAddress(r.address), retired: !!r.retired });
    }
  }
  return out;
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t)); };
const providers = new Map();
function provider(c) {
  if (!providers.has(c.chainId)) providers.set(c.chainId, new ethers.JsonRpcProvider(c.rpc, { chainId: c.chainId, name: c.label }, { staticNetwork: true, batchMaxCount: 1 }));
  return providers.get(c.chainId);
}
const mcSupport = new Map(); // chainId -> bool
async function hasMulticall(c, p) {
  if (!mcSupport.has(c.chainId)) mcSupport.set(c.chainId, (await withTimeout(p.getCode(MULTICALL3), RPC_TIMEOUT_MS, 'getCode')) !== '0x');
  return mcSupport.get(c.chainId);
}
function decode(name, data) {
  const r = iface.decodeFunctionResult(name, data);
  switch (name) {
    case 'pendingOperator': return { operator: r.operator, effectiveAt: Number(r.effectiveAt) };
    case 'pendingGuardian': return { guardian: r.guardian, effectiveAt: Number(r.effectiveAt) };
    case 'pendingTreasury': return { treasury: r.treasury, effectiveAt: Number(r.effectiveAt) };
    case 'pendingApprovers': return { approvers: [...r.approversList], required: Number(r.required), effectiveAt: Number(r.effectiveAt) };
    case 'approvers': return [...r[0]];
    case 'paused': return Boolean(r[0]);
    case 'version': return String(r[0]);
    default: return typeof r[0] === 'bigint' ? Number(r[0]) : r[0];
  }
}
async function readFactory(c, p, f) {
  const calls = FIELDS.map((name) => ({ target: f.address, allowFailure: true, callData: iface.encodeFunctionData(name, []) }));
  let results;
  if (await hasMulticall(c, p)) {
    const mc = new ethers.Contract(MULTICALL3, MC_ABI, p);
    results = await withTimeout(mc.aggregate3.staticCall(calls), RPC_TIMEOUT_MS, `${f.id} multicall`);
  } else {
    results = [];
    for (const call of calls) {
      try { results.push({ success: true, returnData: await withTimeout(p.call({ to: call.target, data: call.callData }), RPC_TIMEOUT_MS, `${f.id} call`) }); }
      catch (e) { if (/timed out|network|SERVER_ERROR/i.test(e.message)) throw e; results.push({ success: false, returnData: '0x' }); }
    }
  }
  const state = {};
  FIELDS.forEach((name, i) => {
    const r = results[i];
    if (!r.success || r.returnData === '0x') { state[name] = null; if (!OPTIONAL.has(name)) state._missing = [...(state._missing || []), name]; return; }
    try { state[name] = decode(name, r.returnData); } catch { state[name] = null; }
  });
  if (state._missing?.length >= FIELDS.length - OPTIONAL.size) throw new Error(`${f.id}: every governance read failed (wrong address or RPC)`);
  return state;
}

// ── snapshot, diff, messages ──────────────────────────────────────────────────────────────────────────────────────
const addrEq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}..${a.slice(-4)}` : 'none');
const ts = (s) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'n/a');
const EXECUTION_WINDOW_S = 7 * 86400; // FactoryGovernance.EXECUTION_WINDOW: after it a due change reverts ChangeExpired
const lapsed = (s, now) => now > s + EXECUTION_WINDOW_S;
const countdown = (s, now) => {
  if (lapsed(s, now)) return 'lapsed (execution window over, can only be cancelled or re-scheduled)';
  const d = s - now; if (d <= 0) return 'due now (anyone can execute)';
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60); return h >= 48 ? `in ${Math.floor(h / 24)} d ${h % 24} h` : `in ${h} h ${m} min`;
};
const label = (f, c) => `${c.label} ${f.tag} (${f.contract} ${short(f.address)}, ${f.gen})`;

/// Everything pending on one factory, for the digest and the JSON "open" list.
function openSchedules(f, c, s) {
  const out = [];
  if (s.pendingOperator?.effectiveAt) out.push({ kind: 'operator', detail: `new operator ${s.pendingOperator.operator}`, effectiveAt: s.pendingOperator.effectiveAt });
  if (s.pendingGuardian?.effectiveAt) out.push({ kind: 'guardian', detail: `new guardian ${s.pendingGuardian.guardian}`, effectiveAt: s.pendingGuardian.effectiveAt });
  if (s.pendingTreasury?.effectiveAt) out.push({ kind: 'treasury', detail: `new treasury ${s.pendingTreasury.treasury}`, effectiveAt: s.pendingTreasury.effectiveAt });
  if (s.pendingApprovers?.effectiveAt) out.push({ kind: 'approvers', detail: `approver set ${s.pendingApprovers.approvers.map(short).join(', ')} required ${s.pendingApprovers.required} (now ${s.approvalsRequired} of ${s.approvers?.length ?? '?'})`, effectiveAt: s.pendingApprovers.effectiveAt });
  if (s.ownershipEffectiveAt) out.push({ kind: 'ownership', detail: `ownership to ${s.pendingOwner}`, effectiveAt: s.ownershipEffectiveAt });
  return out.map((o) => ({ ...o, factory: f.id, chainId: c.chainId, address: f.address }));
}

/// Human lines for what changed between two snapshots of one factory.
function diffFactory(f, c, prev, cur, now) {
  const msgs = [];
  const L = label(f, c);
  const sched = (kind, p, q, who) => {
    if (!p?.effectiveAt && q?.effectiveAt) msgs.push(`SCHEDULED ${kind} on ${L}: ${who(q)}, effective ${ts(q.effectiveAt)} (${countdown(q.effectiveAt, now)}). Cancel window: owner or guardian.`);
    else if (p?.effectiveAt && !q?.effectiveAt) msgs.push(`${kind} schedule on ${L} is gone: ${who(p)} was ${p.effectiveAt <= now ? 'executed or cancelled' : 'cancelled before its time'}.`);
    else if (p?.effectiveAt && q?.effectiveAt && (p.effectiveAt !== q.effectiveAt || JSON.stringify(p) !== JSON.stringify(q))) msgs.push(`RESCHEDULED ${kind} on ${L}: ${who(q)}, effective ${ts(q.effectiveAt)} (${countdown(q.effectiveAt, now)}).`);
  };
  sched('operator', prev.pendingOperator, cur.pendingOperator, (x) => `new operator ${x.operator}`);
  sched('guardian', prev.pendingGuardian, cur.pendingGuardian, (x) => `new guardian ${x.guardian}`);
  sched('treasury', prev.pendingTreasury, cur.pendingTreasury, (x) => `new treasury ${x.treasury}`);
  sched('approver set', prev.pendingApprovers, cur.pendingApprovers, (x) => `${x.approvers.length} approvers, required ${x.required}`);
  sched('ownership transfer', prev.ownershipEffectiveAt ? { effectiveAt: prev.ownershipEffectiveAt, to: prev.pendingOwner } : null, cur.ownershipEffectiveAt ? { effectiveAt: cur.ownershipEffectiveAt, to: cur.pendingOwner } : null, (x) => `to ${x.to}`);
  if (!addrEq(prev.owner, cur.owner)) msgs.push(`OWNER CHANGED on ${L}: ${prev.owner} -> ${cur.owner}.`);
  if (!addrEq(prev.operator, cur.operator)) msgs.push(`OPERATOR CHANGED on ${L}: ${prev.operator} -> ${cur.operator}.`);
  if (!addrEq(prev.guardian, cur.guardian)) msgs.push(`GUARDIAN CHANGED on ${L}: ${prev.guardian} -> ${cur.guardian}.`);
  if (!addrEq(prev.treasury, cur.treasury)) msgs.push(`TREASURY CHANGED on ${L}: ${prev.treasury} -> ${cur.treasury}.`);
  if (JSON.stringify(prev.approvers) !== JSON.stringify(cur.approvers) || prev.approvalsRequired !== cur.approvalsRequired) msgs.push(`APPROVER SET CHANGED on ${L}: now ${cur.approvalsRequired} of ${cur.approvers?.length} [${(cur.approvers || []).map(short).join(', ')}], epoch ${cur.approverEpoch}.`);
  if (prev.paused !== cur.paused) msgs.push(cur.paused ? `PAUSED ${L}: approvals gate paused (no forward / refund-with-approvals until unpause by the owner).` : `UNPAUSED ${L}.`);
  return msgs;
}

/// Posts the lines; returns the lines that did NOT reach Discord (kept in the state file, retried next pass).
async function postDiscord(lines) {
  if (!WEBHOOK || !lines.length) return [];
  // Discord caps content at 2000 chars; chunk, one request per chunk, sequential.
  const chunks = []; let cur = [];
  let len = 0;
  for (const l of lines) { const piece = `• ${l}\n`; if (len + piece.length > 1900 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(l); len += piece.length; }
  if (cur.length) chunks.push(cur);
  const unsent = [];
  for (const chunk of chunks) {
    const content = chunk.map((l) => `• ${l}\n`).join('');
    try {
      const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${content}${PUBLIC_URL ? `\n<${PUBLIC_URL}>` : ''}`, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { console.warn(`[watcher] discord ${res.status}: ${(await res.text()).slice(0, 200)}`); unsent.push(...chunk); }
    } catch (e) { console.warn(`[watcher] discord: ${e.message}`); unsent.push(...chunk); }
    await new Promise((r) => setTimeout(r, 600));
  }
  return unsent;
}

/// Same for a Telegram channel (4096 char cap, plain text, no preview); returns the lines that did not get through.
async function postTelegram(lines) {
  if (!TG_TOKEN || !TG_CHAT || !lines.length) return [];
  const chunks = []; let cur = [];
  let len = 0;
  for (const l of lines) { const piece = `• ${l}\n`; if (len + piece.length > 3800 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(l); len += piece.length; }
  if (cur.length) chunks.push(cur);
  const unsent = [];
  for (const chunk of chunks) {
    const text = `${chunk.map((l) => `• ${l}\n`).join('')}${PUBLIC_URL ? `\n${PUBLIC_URL}` : ''}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { console.warn(`[watcher] telegram ${res.status}: ${(await res.text()).slice(0, 200)}`); unsent.push(...chunk); }
    } catch (e) { console.warn(`[watcher] telegram: ${e.message}`); unsent.push(...chunk); }
    await new Promise((r) => setTimeout(r, 600));
  }
  return unsent;
}

/// Every configured sink gets every line; a line stays in the outbox until it has reached all of them.
async function post(lines) {
  if (!SINKS.length || !lines.length) return [];
  const [d, t] = await Promise.all([postDiscord(lines), postTelegram(lines)]);
  const failed = new Set([...d, ...t]);
  return lines.filter((l) => failed.has(l));
}

// ── one pass ──────────────────────────────────────────────────────────────────────────────────────────────────────
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function pass() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lastFile = path.join(STATE_DIR, 'last.json');
  const last = readJson(lastFile, { factories: {}, digestDay: null });
  const factories = loadFactories();
  const now = Math.floor(Date.now() / 1000);
  const snapshot = { factories: {}, digestDay: last.digestDay };
  const pub = { generatedAt: new Date().toISOString(), source: 'on-chain reads only (FactoryGovernance getters), no database', publicUrl: PUBLIC_URL, chains: [], open: [] };
  const lines = [];
  const byChain = new Map();
  for (const f of factories) { if (!byChain.has(f.chainId)) byChain.set(f.chainId, []); byChain.get(f.chainId).push(f); }

  await Promise.all([...byChain.entries()].map(async ([chainId, list]) => {
    const c = Object.values(CHAINS).find((x) => x.chainId === chainId) || { chainId, label: `chain ${chainId}`, rpc: '' };
    const chainOut = { chainId, label: c.label, rpc: (() => { try { return c.rpc ? new URL(c.rpc).host : null; } catch { return 'invalid url'; } })(), error: null, factories: [] };
    if (!c.rpc) { chainOut.error = 'no RPC configured'; }
    for (const f of list) {
      let state = null, err = null;
      if (c.rpc) { try { state = await readFactory(c, provider(c), f); } catch (e) { err = e.message.split('\n')[0].slice(0, 200); } }
      const prev = last.factories[f.id];
      // after an outage `prev` carries the last good state plus `_error`: compare against it, never skip
      const base = prev && prev.owner !== undefined ? prev : null;
      if (state) {
        snapshot.factories[f.id] = state;
        if (base) lines.push(...diffFactory(f, c, base, state, now));
        else for (const o of openSchedules(f, c, state)) lines.push(`OPEN ${o.kind} schedule on ${label(f, c)}: ${o.detail}, effective ${ts(o.effectiveAt)} (${countdown(o.effectiveAt, now)}).`);
        pub.open.push(...openSchedules(f, c, state).map((o) => ({ ...o, effectiveAtIso: new Date(o.effectiveAt * 1000).toISOString(), lapsed: lapsed(o.effectiveAt, now), countdown: countdown(o.effectiveAt, now) })));
      } else {
        snapshot.factories[f.id] = prev ? { ...prev, _error: err || chainOut.error } : { _error: err || chainOut.error };
        if (!chainOut.error) chainOut.error = err;
      }
      const s = state || base;
      chainOut.factories.push({
        tag: f.tag, contract: f.contract, generation: f.gen, address: f.address, retired: f.retired, stale: !state, error: err,
        ...(s ? {
          version: s.version, owner: s.owner, pendingOwner: s.ownershipEffectiveAt ? s.pendingOwner : null, ownershipEffectiveAt: s.ownershipEffectiveAt || null,
          operator: s.operator, pendingOperator: s.pendingOperator?.effectiveAt ? s.pendingOperator : null,
          guardian: s.guardian, pendingGuardian: s.pendingGuardian?.effectiveAt ? s.pendingGuardian : null,
          approvers: s.approvers, approvalsRequired: s.approvalsRequired, approverEpoch: s.approverEpoch, minApprovalsRequired: s.minApprovalsRequired,
          pendingApprovers: s.pendingApprovers?.effectiveAt ? s.pendingApprovers : null,
          treasury: s.treasury, treasuryImmutable: s.pendingTreasury === null, pendingTreasury: s.pendingTreasury?.effectiveAt ? s.pendingTreasury : null,
          paused: s.paused, refundTimeoutSeconds: s.refundTimeout, looseningEffectiveAt: s.looseningEffectiveAt || null, creationUnlockAt: s.creationUnlockAt || null,
        } : {}),
      });
    }
    pub.chains.push(chainOut);
  }));
  pub.chains.sort((a, b) => a.chainId - b.chainId);
  pub.open.sort((a, b) => a.effectiveAt - b.effectiveAt);
  pub.summary = { factories: factories.length, chains: byChain.size, staleChains: pub.chains.filter((c) => c.error).map((c) => c.label), openSchedules: pub.open.length, paused: pub.chains.flatMap((c) => c.factories).filter((f) => f.paused).length };

  // daily digest while anything is open
  const day = new Date().toISOString().slice(0, 10);
  if (pub.open.length && snapshot.digestDay !== day && new Date().getUTCHours() >= DIGEST_HOUR) {
    lines.push(`Daily digest: ${pub.open.length} open governance schedule(s): ` + pub.open.map((o) => `${o.kind} on ${o.factory} ${o.countdown}`).join('; '));
    snapshot.digestDay = day;
  }
  fs.writeFileSync(path.join(STATE_DIR, 'governance.json'), JSON.stringify(pub, null, 2) + '\n');
  for (const l of lines) console.log(`[watcher] ${l}`);
  // alerts that did not reach a channel last time go first; whatever fails now waits in the state file
  const unsent = await post([...(Array.isArray(last.outbox) ? last.outbox : []), ...lines]);
  snapshot.outbox = SINKS.length ? unsent.slice(-200) : [];
  fs.writeFileSync(lastFile, JSON.stringify(snapshot) + '\n');
  console.log(`[watcher] ${new Date().toISOString()} ${factories.length} factories on ${byChain.size} chains, ${pub.open.length} open, ${pub.summary.paused} paused, stale: ${pub.summary.staleChains.join(', ') || 'none'}, ${lines.length} message(s)${unsent.length ? `, ${unsent.length} unsent (retry next pass)` : ''}`);
}

if (ONCE) await pass();
else for (;;) { try { await pass(); } catch (e) { console.error(`[watcher] pass failed: ${e.message}`); } await new Promise((r) => setTimeout(r, INTERVAL_MS)); }
