// ============================================================
// Wraith Stealth Playground — playground.js
// Stepper UI + the four guided steps (derive → send → scan →
// withdraw). All crypto lives in scanner.js; this file only
// wires DOM to engine and manages the fixture data + session
// state. Zero network calls: fixtures are fetched once from the
// same origin, everything else is in-memory.
// ============================================================

'use strict';

// ── Session state (lives for the lifetime of the iframe) ────
const state = {
  fixtures: null,          // parsed fixtures.json
  derived: null,           // output of the derive step
  sessionEvents: [],       // Horizon events constructed in the send step
  sessionAnnouncements: [],// parsed versions of the above
  scanMatches: [],         // last scan results
  sendNonce: 0,            // deterministic ephemeral key counter
};

const STEPS = ['derive', 'send', 'scan', 'withdraw'];
const STEP_LABELS = {
  derive: 'Derive',
  send: 'Send',
  scan: 'Scan',
  withdraw: 'Withdraw',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ── Stepper ─────────────────────────────────────────────────
function activateStep(step) {
  if (!STEPS.includes(step)) step = 'derive';
  for (const s of STEPS) {
    $('panel-' + s).hidden = s !== step;
    $('stepper-' + s).classList.toggle('active', s === step);
  }
  if (step === 'withdraw') renderWithdraw();
  if (step === 'scan') renderFixtureTable();
  syncPermalink();
}

// ── Status / result helpers ─────────────────────────────────
function statusBar(kind, html) {
  return `<div class="status-bar"><span class="dot dot-${kind}"></span><span>${html}</span></div>`;
}

function kvRow(k, v, mono = true) {
  return `<div class="kv-row"><span class="k">${k}</span><span class="v${mono ? '' : ' v-plain'}">${v}</span></div>`;
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { /* ignore */ }
  document.body.removeChild(ta);
}

// ── Fixture loading ─────────────────────────────────────────
async function loadFixtures() {
  const res = await fetch('fixtures.json');
  if (!res.ok) throw new Error(`fixtures.json returned ${res.status}`);
  state.fixtures = await res.json();

  const r = state.fixtures.recipient;
  // The derive step defaults to the demo wallet signature.
  $('sigInput').value = r.signature;
  // The send step defaults to the demo recipient.
  $('sendMeta').value = r.metaAddress;
  // The scan step defaults to the demo keys.
  $('scanMeta').value = r.metaAddress;
  $('scanVk').value = r.viewingKey;
  $('scanScalar').value = r.spendingScalar;
  // The withdraw step defaults to the demo wallet.
  $('wdDest').value = r.walletAddress;

  // Parse fixture events into announcements for the scan step.
  state.fixtureAnnouncements = (state.fixtures.events || [])
    .map(parseHorizonEvent)
    .filter(Boolean);
}

// ── Derive step ─────────────────────────────────────────────
async function runDerive() {
  const sigRaw = $('sigInput').value.trim();
  const out = $('deriveResults');
  if (!/^[0-9a-fA-F]{128}$/.test(sigRaw)) {
    out.innerHTML = statusBar('err', 'Signature must be 128 hex chars (a 64-byte ed25519 signature).');
    return;
  }
  try {
    const keys = await deriveStealthKeys(hexToBytes(sigRaw));
    state.derived = keys;

    const metaAddress = `st:xlm:${bytesToHex(keys.spendingPubKey)}${bytesToHex(keys.viewingPubKey)}`;

    out.innerHTML = `
      ${statusBar('done', 'Keys derived — the meta-address below is what you share to receive payments.')}
      <div class="card">
        ${kvRow('Spending key seed', `<code>${bytesToHex(keys.spendingKey)}</code>`)}
        ${kvRow('Viewing key seed', `<code>${bytesToHex(keys.viewingKey)}</code>`)}
        ${kvRow('Spending scalar', `<code class="wrap">${keys.spendingScalar.toString()}</code>`)}
        ${kvRow('Viewing scalar', `<code class="wrap">${keys.viewingScalar.toString()}</code>`)}
        ${kvRow('Spending pub key', `<code>${pubKeyToStellarAddress(keys.spendingPubKey)}</code>`)}
        ${kvRow('Viewing pub key', `<code>${pubKeyToStellarAddress(keys.viewingPubKey)}</code>`)}
      </div>
      <div class="card card-accent">
        <div class="kv-row"><span class="k">Stealth meta-address</span>
          <span class="v"><code class="wrap">${esc(metaAddress)}</code></span></div>
        <button class="ghost small" id="copyMetaBtn">Copy meta-address</button>
      </div>
      <p class="hint">The seeds are <code>SHA-256("wraith:spending:" ‖ signature)</code> and
        <code>SHA-256("wraith:viewing:" ‖ signature)</code> — the same split the SDK performs.</p>`;

    $('copyMetaBtn').addEventListener('click', () => copyText(metaAddress, $('copyMetaBtn')));
  } catch (err) {
    out.innerHTML = statusBar('err', `Derivation failed: ${esc(err.message)}`);
  }
}

// ── Send step ───────────────────────────────────────────────
async function constructAnnouncement() {
  const metaRaw = $('sendMeta').value.trim();
  const amount = $('sendAmount').value.trim();
  const asset = $('sendAsset').value;
  const out = $('sendResults');

  if (!metaRaw.startsWith('st:xlm:')) {
    out.innerHTML = statusBar('err', 'Recipient meta-address must start with <code>st:xlm:</code>.');
    return;
  }
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    out.innerHTML = statusBar('err', 'Amount must be a positive number.');
    return;
  }

  try {
    const { spendingPubKey, viewingPubKey } = decodeStealthMetaAddress(metaRaw);

    // Deterministic one-time ephemeral keypair per click, so the demo is
    // reproducible — the real protocol uses a random seed.
    const ephSeed = await sha256(strToBytes('wraith:eph:'), strToBytes(String(state.sendNonce++)));
    const gen = await generateStealthAddress(spendingPubKey, viewingPubKey, ephSeed);

    // metadata = 32 bytes, first byte is the view tag
    const metadata = new Uint8Array(32);
    metadata[0] = gen.viewTag;

    const announcement = {
      schemeId: 1,
      stealthAddress: gen.stealthAddress,
      caller: pubKeyToStellarAddress(gen.ephemeralPubKey),
      ephemeralPubKey: bytesToHex(gen.ephemeralPubKey),
      metadata: bytesToHex(metadata),
    };

    const event = encodeHorizonEvent(announcement, {
      ledger: (state.fixtures ? state.fixtures.events[state.fixtures.events.length - 1].ledger : 51234000) + 1,
    });

    state.sessionEvents.push(event);
    state.sessionAnnouncements.push(announcement);
    renderFixtureTable();

    out.innerHTML = `
      ${statusBar('done', `Announcement constructed and added to the scan batch (now ${state.sessionEvents.length} in-batch).`)}
      <div class="card card-accent">
        ${kvRow('Stealth address (recipient)', `<code>${announcement.stealthAddress}</code>`)}
        ${kvRow('View tag', `<code>0x${gen.viewTag.toString(16).padStart(2, '0')}</code>`)}
        ${kvRow('Ephemeral pub key', `<code class="wrap">${announcement.ephemeralPubKey}</code>`)}
        ${kvRow('Payment', `<code>${esc(amount)} ${esc(asset)} → stealth address</code>`)}
      </div>
      <details class="fixture-section">
        <summary>Horizon event emitted by this payment</summary>
        <pre class="code-block">${esc(JSON.stringify(event, null, 2))}</pre>
      </details>
      <p class="hint">The <code>stealth-sender</code> contract transfers the asset and the
        <code>stealth-announcer</code> contract emits this event in the same transaction.</p>`;
  } catch (err) {
    out.innerHTML = statusBar('err', `Send failed: ${esc(err.message)}`);
  }
}

// ── Scan step ───────────────────────────────────────────────
function allAnnouncements() {
  const fixtures = state.fixtureAnnouncements || [];
  return fixtures.concat(state.sessionAnnouncements);
}

async function runScan() {
  const metaRaw = $('scanMeta').value.trim();
  const vkRaw = $('scanVk').value.trim();
  const ssRaw = $('scanScalar').value.trim();
  const out = $('scanResults');
  const errors = [];

  let spendingPubKey = null;
  if (metaRaw.startsWith('st:xlm:')) {
    try { spendingPubKey = decodeStealthMetaAddress(metaRaw).spendingPubKey; }
    catch (e) { errors.push(`meta-address: ${e.message}`); }
  } else if (metaRaw) {
    errors.push('meta-address must start with st:xlm:');
  }

  let viewingKey = null;
  if (/^[0-9a-fA-F]{64}$/.test(vkRaw)) {
    viewingKey = hexToBytes(vkRaw);
  } else {
    errors.push('viewing key must be 64 hex chars');
  }

  let spendingScalar = null;
  try { spendingScalar = BigInt(ssRaw); } catch (_) { errors.push('spending scalar must be a decimal integer'); }

  if (errors.length > 0) {
    out.innerHTML = statusBar('err', `Fix: ${esc(errors.join('; '))}.`);
    return;
  }

  const announcements = allAnnouncements();
  const btn = $('scanBtn');
  btn.disabled = true;
  out.innerHTML = statusBar('scanning', `Scanning ${announcements.length} announcements…`);

  const t0 = performance.now();
  try {
    state.scanMatches = await scanAnnouncements(announcements, viewingKey, spendingPubKey, spendingScalar);
    const elapsed = Math.round(performance.now() - t0);

    if (state.scanMatches.length === 0) {
      out.innerHTML = statusBar('done',
        `Scanned ${announcements.length} announcements in ${elapsed}ms — no matches.`) +
        `<div class="no-match">No announcements matched these keys.</div>`;
    } else {
      out.innerHTML = statusBar('done',
        `Scanned <strong>${announcements.length}</strong> announcements in ${elapsed}ms — ` +
        `<strong>${state.scanMatches.length}</strong> match${state.scanMatches.length === 1 ? '' : 'es'} found.`);
      for (const m of state.scanMatches) {
        out.insertAdjacentHTML('beforeend', `
          <div class="match-card">
            <div class="tag">Match</div>
            ${kvRow('Stealth address', `<code>${m.stealthAddress}</code>`)}
            ${kvRow('Ephemeral pub key', `<code class="wrap">${m.ephemeralPubKey}</code>`)}
            ${kvRow('Stealth pub key (hex)', `<code class="wrap">${bytesToHex(m.stealthPubKeyBytes)}</code>`)}
            ${kvRow('Stealth private scalar', `<code class="wrap">${m.stealthPrivateScalar.toString()}</code>`)}
          </div>`);
      }
      out.insertAdjacentHTML('beforeend',
        `<p class="hint">The stealth private scalar is what signs withdrawals from the stealth address — see the Withdraw step.</p>`);
    }
    renderFixtureTable();
  } catch (err) {
    out.innerHTML = statusBar('err', `Scan failed: ${esc(err.message)}`);
  } finally {
    btn.disabled = false;
  }
}

function renderFixtureTable() {
  const table = $('fixtureTable');
  const announcements = allAnnouncements();
  const yours = new Set(state.scanMatches.map((m) => m.ephemeralPubKey));
  table.innerHTML = '';
  if (announcements.length === 0) return;

  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>#</th><th>Stealth Address</th><th>Ephemeral Pub Key</th><th>View Tag</th><th>Owner</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  announcements.forEach((ann, i) => {
    const viewTag = parseInt(ann.metadata.slice(0, 2), 16);
    const isMatch = yours.has(ann.ephemeralPubKey);
    const badge = isMatch
      ? '<span class="badge-yours">match</span>'
      : '<span class="badge-other">other</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${esc(trunc(ann.stealthAddress, 8))}</td>
      <td>${esc(trunc(ann.ephemeralPubKey, 8))}</td>
      <td>0x${viewTag.toString(16).padStart(2, '0')}</td>
      <td>${badge}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function trunc(hex, n = 12) {
  return hex.length <= n * 2 ? hex : hex.slice(0, n) + '…' + hex.slice(-6);
}

// ── Withdraw step ───────────────────────────────────────────
async function renderWithdraw() {
  const out = $('withdrawResults');
  if (!state.fixtures) return;
  const r = state.fixtures.recipient;
  const dest = $('wdDest').value.trim() || r.walletAddress;

  const viewingKey = hexToBytes(r.viewingKey);
  const spendingPub = hexToBytes(r.spendingPubKey);
  const spendingScalar = BigInt(r.spendingScalar);

  const matches = await scanAnnouncements(allAnnouncements(), viewingKey, spendingPub, spendingScalar);

  out.innerHTML = statusBar('done',
    `<strong>${matches.length}</strong> withdrawable stealth balance${matches.length === 1 ? '' : 's'} found with the demo keys.`);

  for (const m of matches) {
    out.insertAdjacentHTML('beforeend', `
      <div class="match-card" data-eph="${esc(m.ephemeralPubKey)}">
        <div class="tag">Stealth balance</div>
        ${kvRow('Stealth address', `<code>${m.stealthAddress}</code>`)}
        ${kvRow('Private scalar (signs withdrawals)', `<code class="wrap">${m.stealthPrivateScalar.toString()}</code>`)}
        <button class="ghost small withdraw-btn">Withdraw to ${esc(trunc(dest, 10))}</button>
        <div class="withdraw-out"></div>
      </div>`);
  }

  out.querySelectorAll('.withdraw-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderWithdrawal(btn, dest));
  });

  if (matches.length === 0) {
    out.insertAdjacentHTML('beforeend',
      `<div class="no-match">No balances — construct an announcement in the Send step and scan it first.</div>`);
  }
}

function renderWithdrawal(btn, dest) {
  const card = btn.closest('.match-card');
  const out = card.querySelector('.withdraw-out');
  // Order of kv-rows in the card: [stealth address, private scalar].
  const values = card.querySelectorAll('.kv-row .v code');
  const addr = values[0].textContent;
  const scalar = values[1].textContent;

  const tx = {
    operations: [
      { type: 'payment', from: addr, to: dest, asset: 'XLM', amount: 'all' },
    ],
    signer: scalar,
    note: 'Signed with the stealth private scalar — the recipient of the payment is the only party who can do this.',
  };

  out.innerHTML = `
    <details class="fixture-section" open>
      <summary>Simulated withdrawal transaction</summary>
      <pre class="code-block">${esc(JSON.stringify(tx, null, 2))}</pre>
    </details>
    <p class="hint privacy-note">Privacy: space real withdrawals at least 1 hour apart and avoid uniform round amounts —
      see <a href="/guides/privacy-best-practices">Privacy Best Practices</a>.</p>`;
}

// ── Reset buttons ───────────────────────────────────────────
function resetStep(step) {
  if (!state.fixtures) return;
  const r = state.fixtures.recipient;
  if (step === 'derive') {
    $('sigInput').value = r.signature;
    $('deriveResults').innerHTML = '';
    state.derived = null;
  } else if (step === 'send') {
    $('sendMeta').value = r.metaAddress;
    $('sendAmount').value = '';
    $('sendAsset').value = 'XLM';
    $('sendResults').innerHTML = '';
    state.sessionEvents = [];
    state.sessionAnnouncements = [];
    state.sendNonce = 0;
  } else if (step === 'scan') {
    $('scanMeta').value = r.metaAddress;
    $('scanVk').value = r.viewingKey;
    $('scanScalar').value = r.spendingScalar;
    $('scanResults').innerHTML = '';
    state.scanMatches = [];
    renderFixtureTable();
  } else if (step === 'withdraw') {
    $('wdDest').value = r.walletAddress;
    $('withdrawResults').innerHTML = '';
  }
}

// ── Permalinks ──────────────────────────────────────────────
function buildPermalink() {
  const params = new URLSearchParams();
  params.set('step', currentStep());
  const sig = $('sigInput').value.trim();
  if (sig) params.set('sig', sig);
  const meta = $('sendMeta').value.trim();
  if (meta) params.set('meta', meta);
  const amount = $('sendAmount').value.trim();
  if (amount) params.set('amount', amount);
  const asset = $('sendAsset').value;
  if (asset) params.set('asset', asset);
  const vk = $('scanVk').value.trim();
  if (vk) params.set('vk', vk);
  const scalar = $('scanScalar').value.trim();
  if (scalar) params.set('scalar', scalar);
  const dest = $('wdDest').value.trim();
  if (dest) params.set('dest', dest);
  return `${location.pathname}?${params.toString()}`;
}

let _currentStep = 'derive';
function currentStep() { return _currentStep; }

function syncPermalink() {
  const p = buildPermalink();
  for (const s of STEPS) {
    const link = $('permalink-' + s);
    if (link) link.dataset.url = p;
  }
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  try {
    await loadFixtures();
  } catch (err) {
    $('bootError').hidden = false;
    $('bootError').innerHTML = statusBar('err',
      `Could not load <code>fixtures.json</code> (${esc(err.message)}). ` +
      `Serve the playground over HTTP — opening it via <code>file://</code> or embedding without ` +
      `<code>allow-same-origin</code> blocks the fixture request.`);
    return;
  }

  // Wire stepper.
  for (const s of STEPS) {
    $('stepper-' + s).addEventListener('click', () => {
      _currentStep = s;
      activateStep(s);
    });
    $('reset-' + s).addEventListener('click', () => resetStep(s));
    $('permalink-' + s).addEventListener('click', (e) => {
      e.preventDefault();
      copyText(new URL($('permalink-' + s).dataset.url, location.href).href, $('permalink-' + s));
    });
  }

  $('deriveBtn').addEventListener('click', runDerive);
  $('constructBtn').addEventListener('click', constructAnnouncement);
  $('scanBtn').addEventListener('click', runScan);
  $('loadFixture').addEventListener('click', () => resetStep('scan'));

  // Read the step (and optional prefilled inputs) from the URL.
  const params = new URLSearchParams(location.search);
  _currentStep = params.get('step') || 'derive';
  if (!STEPS.includes(_currentStep)) _currentStep = 'derive';
  if (params.get('sig')) $('sigInput').value = params.get('sig');
  if (params.get('meta')) $('sendMeta').value = params.get('meta');
  if (params.get('amount')) $('sendAmount').value = params.get('amount');
  if (params.get('asset')) $('sendAsset').value = params.get('asset');
  if (params.get('vk')) $('scanVk').value = params.get('vk');
  if (params.get('scalar')) $('scanScalar').value = params.get('scalar');
  if (params.get('dest')) $('wdDest').value = params.get('dest');

  renderFixtureTable();
  activateStep(_currentStep);
}

document.addEventListener('DOMContentLoaded', boot);
