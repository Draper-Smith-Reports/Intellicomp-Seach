// ==UserScript==
// @name         IntelliComp Lead Search (Draper Smith)
// @namespace    https://github.com/Draper-Smith-Reports/Intellicomp-Seach
// @version      1.1.0
// @description  Upload a contractor list, look each one up in IntelliComp one at a time (name search + address match), and download the ex mods as a spreadsheet with mod-review links.
// @match        https://exmod.com/*
// @match        https://www.exmod.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const CONFIG = {
    landingPage: 'https://draper-smith-reports.github.io/Mod-Review/',
    defaultDelaySeconds: 3,   // pause between page loads so IntelliComp's server isn't hammered
    defaultMaxRows: 100,      // rows per run; the rest stay queued for the next run
    autoMatchScore: 4,        // address score needed to pick a result without asking you
  };

  const STATE_KEY = 'icls_state_v1';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const headerKey = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const STREET_ABBR = {
    STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', ROAD: 'RD', BOULEVARD: 'BLVD',
    LANE: 'LN', COURT: 'CT', PLACE: 'PL', HIGHWAY: 'HWY', PARKWAY: 'PKWY', CIRCLE: 'CIR',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', SUITE: 'STE',
  };
  const normStreet = (s) => norm(s).split(' ').map((w) => STREET_ABBR[w] || w).join(' ');

  const BIZ_SUFFIXES = new Set([
    'INC', 'INCORPORATED', 'LLC', 'L L C', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD',
    'LP', 'LLP', 'PC', 'THE', 'A', 'CALIFORNIA', 'CA',
  ]);

  // Turns "LIGHTHOUSE ELECTRICAL, INC. DBA LIGHTHOUSE HOME" into "LIGHTHOUSE ELECTRICAL"
  function searchTermFor(name) {
    let n = norm(name).split(/\bDBA\b/)[0];
    const words = n.split(' ').filter((w) => w && !BIZ_SUFFIXES.has(w));
    return words.join(' ');
  }

  function titleCase(s) {
    return clean(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((v) => v !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map((h) => h.replace(/^﻿/, '').trim());
    const records = rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
      return o;
    });
    return { headers, records };
  }

  function toCSV(headers, records) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers.map(esc).join(',')]
      .concat(records.map((r) => headers.map((h) => esc(r[h])).join(',')))
      .join('\r\n');
  }

  // Works with the CSLB master list headers and with simple hand-made lists.
  const COLUMN_ALIASES = {
    name: ['businessname', 'fullbusinessname', 'company', 'companyname', 'name', 'business'],
    address: ['mailingaddress', 'address', 'street', 'streetaddress', 'address1'],
    city: ['city'],
    zip: ['zipcode', 'zip', 'postalcode'],
    license: ['licenseno', 'licensenumber', 'license', 'lic', 'licno', 'cslblicense'],
    phone: ['businessphone', 'phone', 'phonenumber'],
  };

  function mapColumns(headers) {
    const keys = headers.map(headerKey);
    const map = {};
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      for (const a of aliases) {
        const i = keys.indexOf(a);
        if (i !== -1) { map[field] = headers[i]; break; }
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Page parsers (pure functions: take a Document, return data)
  // ---------------------------------------------------------------------------
  function isLoginPage(doc) {
    if (doc.querySelector('.log_out_btn')) return false;
    return !!doc.querySelector('input[type=password]') || /Subscriber Login/i.test(doc.body ? doc.body.textContent : '');
  }

  function isEmployerPage(doc) {
    return !!doc.querySelector('.bureau-report');
  }

  // "Bureau Search Results" page: one row per WCIRB risk
  function parseSearchResults(doc) {
    return Array.from(doc.querySelectorAll('tr.employer_row')).map((tr) => {
      const cells = tr.querySelectorAll('td');
      const names = Array.from(cells[1] ? cells[1].querySelectorAll('div') : []).map((d) => ({
        text: clean(d.textContent).replace(/^\*/, ''),
        inactive: d.classList.contains('deprecated') || clean(d.textContent).startsWith('*'),
      }));
      const address = clean(cells[2] ? cells[2].textContent : '');
      return { wcirb: tr.getAttribute('data-wcirb') || clean(cells[0] && cells[0].textContent), names, address };
    });
  }

  function fieldAfterTitle(root, label) {
    if (!root) return '';
    const want = label.toUpperCase();
    for (const s of root.querySelectorAll('span.title')) {
      if (clean(s.textContent).toUpperCase().replace(/:$/, '') === want) {
        const v = s.nextElementSibling;
        return v ? clean(v.textContent) : '';
      }
    }
    return '';
  }

  // Employer page: bureau report + contractor's licence data tabs
  function parseEmployer(doc) {
    const br = doc.querySelector('#bureauReportTab') || doc;
    const report = br.querySelector('.bureau-report') || br;

    const names = Array.from(report.querySelectorAll('p.title'))
      .filter((p) => !p.closest('.deprecatedNames'))
      .map((p) => clean(p.textContent));

    const mods = Array.from(report.querySelectorAll('table.exmods table.std_table tbody tr')).map((tr) => {
      const td = tr.querySelectorAll('td');
      const get = (i) => clean(td[i] ? td[i].textContent : '');
      const inactive = !!tr.querySelector('.deprecated') || get(0).startsWith('*');
      return { year: get(0).replace(/^\*/, ''), calcDate: get(1), mod: get(2), status: get(3), inactive };
    }).filter((m) => m.year);

    const classCodes = Array.from(report.querySelectorAll('table.class_codes table.std_table tbody tr')).map((tr) => {
      const td = tr.querySelectorAll('td');
      const get = (i) => clean(td[i] ? td[i].textContent : '');
      return { code: get(0).replace(/^\*/, ''), sub: get(1), desc: get(2), inactive: !!tr.querySelector('.deprecated') };
    }).filter((c) => c.code);

    const cslbRoot = doc.querySelector('#CSLBTab');
    const cslbMatches = cslbRoot ? Array.from(cslbRoot.querySelectorAll('[id^="match_"]')).map((m) => ({
      license: fieldAfterTitle(m, "Contractor's Licence Number") || fieldAfterTitle(m, "Contractor's License Number"),
      businessName: fieldAfterTitle(m, 'Business Name'),
      licenseType: fieldAfterTitle(m, 'License Type'),
      address: fieldAfterTitle(m, "Contractor's Address"),
      insurer: fieldAfterTitle(m, 'Insurance Company'),
      policy: fieldAfterTitle(m, 'Policy Number'),
      effective: fieldAfterTitle(m, 'Effective Date'),
      expiration: fieldAfterTitle(m, 'Expiration Date'),
    })) : [];

    return {
      wcirb: fieldAfterTitle(report, 'WCIRB NUMBER'),
      projectedEffective: fieldAfterTitle(report, 'Projected Effective Dates'),
      address: fieldAfterTitle(report, 'WCIRB Address').replace(/\s+,/g, ','),
      contact: fieldAfterTitle(report, 'Contact'),
      contactTitle: fieldAfterTitle(report, 'Title'),
      phone: fieldAfterTitle(report, 'Phone Number'),
      names,
      mods,
      classCodes,
      cslbMatches,
    };
  }

  // ---------------------------------------------------------------------------
  // Matching: same idea as comparing addresses by eye
  // ---------------------------------------------------------------------------
  // Result-list addresses are cut short, e.g. "520 PARK C..., CLOVIS"
  function splitResultAddress(addr) {
    const i = addr.lastIndexOf(',');
    if (i === -1) return { street: addr.replace(/\.\.\.$/, ''), city: '' };
    return { street: addr.slice(0, i).replace(/\.\.\.$/, '').trim(), city: addr.slice(i + 1).trim() };
  }

  function scoreCandidate(cand, input) {
    let score = 0;
    const reasons = [];
    const { street, city } = splitResultAddress(cand.address);
    const cStreet = normStreet(street);
    const iStreet = normStreet(input.address);
    const cNum = (cStreet.match(/^\d+/) || [''])[0];
    const iNum = (iStreet.match(/^\d+/) || [''])[0];

    if (input.city && city && norm(city) === norm(input.city)) { score += 2; reasons.push('city'); }
    if (cNum && iNum && cNum === iNum) { score += 2; reasons.push('street #'); }
    if (cStreet.length >= 4 && iStreet.startsWith(cStreet)) { score += 1; reasons.push('street'); }

    const active = cand.names.filter((n) => !n.inactive);
    if (active.some((n) => norm(n.text) === norm(input.name))) { score += 2; reasons.push('exact name'); }
    else if (active.some((n) => searchTermFor(n.text) === searchTermFor(input.name))) { score += 1; reasons.push('name'); }
    if (!active.length) { score -= 1; reasons.push('inactive name only'); }

    return { score, reasons };
  }

  function pickCandidate(candidates, input) {
    const scored = candidates.map((c) => ({ ...c, ...scoreCandidate(c, input) }))
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return { pick: null, scored };
    const top = scored[0];
    const tie = scored[1] && scored[1].score === top.score;
    if (top.score >= CONFIG.autoMatchScore && !tie) return { pick: top, scored };
    return { pick: null, scored };
  }

  // ---------------------------------------------------------------------------
  // Output row
  // ---------------------------------------------------------------------------
  const fmtMod = (m) => (/^\d{3}$/.test(m) ? (parseInt(m, 10) / 100).toFixed(2) : m);

  function buildResult(input, emp, how, srcTag) {
    const active = emp.mods.filter((m) => !m.inactive);
    const cur = active[0];
    const prev = active[1];
    let change = '';
    if (cur && prev && /^\d+$/.test(cur.mod) && /^\d+$/.test(prev.mod)) {
      const d = parseInt(cur.mod, 10) - parseInt(prev.mod, 10);
      change = (d > 0 ? '+' : '') + (d / 100).toFixed(2);
    }

    const inLic = (input.license || '').replace(/\D/g, '');
    const cslb = emp.cslbMatches.find((m) => m.license.replace(/\D/g, '') === inLic) || emp.cslbMatches[0] || {};
    let licenseCheck = '';
    if (inLic && emp.cslbMatches.length) {
      licenseCheck = emp.cslbMatches.some((m) => m.license.replace(/\D/g, '') === inLic) ? 'license matches' : 'license DIFFERENT - check';
    }

    const city = (emp.address.match(/,\s*([^,]+),\s*CA/i) || [])[1] || input.city || '';
    const params = new URLSearchParams();
    if (emp.contact) params.set('name', titleCase(emp.contact));
    // Use the name from your list (the one the contractor knows), not the WCIRB file name
    params.set('company', titleCase(input.name || emp.names[0]));
    if (city) params.set('city', titleCase(city));
    if (emp.phone || input.phone) params.set('phone', emp.phone || input.phone);
    if (srcTag) params.set('src', srcTag);

    return {
      ic_status: 'found',
      ic_how_matched: how,
      ic_license_check: licenseCheck,
      ic_wcirb: emp.wcirb,
      ic_wcirb_name: emp.names.join(' / '),
      ic_wcirb_address: emp.address,
      ic_contact: emp.contact,
      ic_contact_title: emp.contactTitle,
      ic_phone: emp.phone,
      ic_current_mod_year: cur ? cur.year : '',
      ic_current_mod: cur ? fmtMod(cur.mod) : '',
      ic_prior_mod: prev ? fmtMod(prev.mod) : '',
      ic_mod_change: change,
      ic_mod_status: cur ? cur.status : '',
      ic_projected_effective: emp.projectedEffective,
      ic_class_codes: emp.classCodes.filter((c) => !c.inactive).map((c) => c.code + (c.sub ? '-' + c.sub : '') + ' ' + c.desc).join('; '),
      ic_wc_insurer: cslb.insurer || '',
      ic_wc_policy: cslb.policy || '',
      ic_wc_effective: cslb.effective || '',
      ic_wc_expiration: cslb.expiration || '',
      ic_mod_review_link: CONFIG.landingPage + '?' + params.toString(),
      ic_candidates: '',
    };
  }

  const OUTPUT_FIELDS = [
    'ic_status', 'ic_how_matched', 'ic_license_check', 'ic_wcirb', 'ic_wcirb_name', 'ic_wcirb_address',
    'ic_contact', 'ic_contact_title', 'ic_phone', 'ic_current_mod_year', 'ic_current_mod', 'ic_prior_mod',
    'ic_mod_change', 'ic_mod_status', 'ic_projected_effective', 'ic_class_codes', 'ic_wc_insurer',
    'ic_wc_policy', 'ic_wc_effective', 'ic_wc_expiration', 'ic_mod_review_link', 'ic_candidates',
  ];

  // Exported for tests (Node). In the browser this block is skipped.
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      parseCSV, toCSV, mapColumns, searchTermFor, parseSearchResults, parseEmployer,
      isLoginPage, isEmployerPage, scoreCandidate, pickCandidate, buildResult, splitResultAddress, OUTPUT_FIELDS,
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Browser side: fetch pages in the logged-in session
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class LoggedOutError extends Error {}

  async function getDoc(path) {
    const res = await fetch(new URL(path, location.origin), { credentials: 'same-origin' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (/\/login/i.test(res.url) || isLoginPage(doc)) throw new LoggedOutError('Logged out');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return doc;
  }

  const searchPath = (term) => '/Employer/Search?search=' + encodeURIComponent(term);
  const employerPath = (wcirb) => '/Employer?EmployerFilter=' + encodeURIComponent(wcirb);

  // ---------------------------------------------------------------------------
  // Saved state (survives page reloads, so a run can be resumed)
  // ---------------------------------------------------------------------------
  function loadState() {
    try { return JSON.parse(GM_getValue(STATE_KEY, 'null')); } catch (e) { return null; }
  }
  function saveState(s) { GM_setValue(STATE_KEY, JSON.stringify(s)); }

  let state = loadState();
  let running = false;
  let stopRequested = false;

  // ---------------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------------
  const css = `
    #icls{position:fixed;right:16px;bottom:16px;width:380px;max-height:80vh;overflow:auto;z-index:99999;
      background:#fff;color:#1d2433;border:1px solid #c9d1de;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);
      font:13px/1.4 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
    #icls *{box-sizing:border-box;font-family:inherit}
    #icls header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#123a6b;color:#fff;border-radius:10px 10px 0 0;cursor:pointer}
    #icls header b{font-size:14px}
    #icls .body{padding:12px}
    #icls label{display:block;margin:8px 0 3px;font-weight:600}
    #icls input[type=text],#icls input[type=number]{width:100%;padding:5px 7px;border:1px solid #c9d1de;border-radius:6px}
    #icls .row{display:flex;gap:8px}
    #icls .row>div{flex:1}
    #icls button{margin:8px 6px 0 0;padding:6px 12px;border:0;border-radius:6px;background:#123a6b;color:#fff;cursor:pointer}
    #icls button.secondary{background:#e6ebf3;color:#123a6b}
    #icls button:disabled{opacity:.45;cursor:default}
    #icls .status{margin-top:10px;padding:8px;background:#f3f6fa;border-radius:6px}
    #icls .log{margin-top:8px;max-height:140px;overflow:auto;font:11px/1.35 ui-monospace,Consolas,monospace;color:#4a5568;white-space:pre-wrap}
    #icls .review{margin-top:10px;border-top:1px solid #e2e8f0;padding-top:8px}
    #icls .item{margin:8px 0;padding:8px;border:1px solid #e2e8f0;border-radius:6px}
    #icls .item .in{font-weight:600}
    #icls .item label{font-weight:400;display:flex;gap:6px;margin:4px 0;align-items:flex-start}
    #icls .muted{color:#718096;font-size:12px}
    #icls.min .body{display:none}
  `;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    kids.flat().forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(k)));
    return e;
  }

  let ui = {};

  function buildPanel() {
    if (document.getElementById('icls')) return;
    if (!document.querySelector('.log_out_btn')) return; // only show when logged in
    document.head.append(el('style', {}, css));

    ui.file = el('input', { type: 'file', accept: '.csv,text/csv' });
    ui.src = el('input', { type: 'text', value: 'intellicomp-' + new Date().toISOString().slice(0, 7) });
    ui.delay = el('input', { type: 'number', min: '1', step: '1', value: String(CONFIG.defaultDelaySeconds) });
    ui.max = el('input', { type: 'number', min: '1', step: '1', value: String(CONFIG.defaultMaxRows) });
    ui.start = el('button', { onclick: start }, 'Run');
    ui.stop = el('button', { class: 'secondary', onclick: () => { stopRequested = true; log('Stopping after this contractor...'); } }, 'Pause');
    ui.download = el('button', { class: 'secondary', onclick: download }, 'Download results');
    ui.clear = el('button', { class: 'secondary', onclick: clearAll }, 'Clear');
    ui.status = el('div', { class: 'status' });
    ui.review = el('div', { class: 'review' });
    ui.log = el('div', { class: 'log' });

    const panel = el('div', { id: 'icls' },
      el('header', { onclick: (e) => { if (e.target.tagName !== 'BUTTON') panel.classList.toggle('min'); } },
        el('b', {}, 'Generate leads'), el('span', { class: 'muted', style: 'color:#cfe0f5' }, 'click to hide')),
      el('div', { class: 'body' },
        el('label', {}, 'Contractor list (CSV)'), ui.file,
        el('div', { class: 'muted' }, 'Needs a business name column. Address, city, zip and license # improve matching.'),
        el('label', {}, 'Mailer tag (src)'), ui.src,
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, 'Seconds between lookups'), ui.delay),
          el('div', {}, el('label', {}, 'Rows this run'), ui.max)),
        ui.start, ui.stop, ui.download, ui.clear,
        ui.status, ui.review, ui.log));
    document.body.append(panel);
    ui.file.addEventListener('change', loadFile);
    render();
  }

  function log(msg) {
    if (!ui.log) return;
    const t = new Date().toLocaleTimeString();
    ui.log.textContent = `[${t}] ${msg}\n` + ui.log.textContent;
  }

  function counts() {
    const c = { total: 0, pending: 0, found: 0, review: 0, notFound: 0, error: 0, skipped: 0 };
    if (!state) return c;
    for (const r of state.rows) {
      c.total++;
      const s = r.result.ic_status;
      if (!s) c.pending++; else if (s === 'found') c.found++; else if (s === 'needs review') c.review++;
      else if (s === 'not found') c.notFound++; else if (s === 'skipped') c.skipped++; else c.error++;
    }
    return c;
  }

  function render() {
    if (!ui.status) return;
    const c = counts();
    ui.start.disabled = running || !state || (!c.pending);
    ui.stop.disabled = !running;
    ui.download.disabled = !state || c.total === c.pending;
    ui.clear.disabled = running || !state;
    ui.status.textContent = !state ? 'Load a CSV to begin.' :
      `${state.fileName}: ${c.total} rows — ${c.found} found, ${c.review} need your pick, ${c.notFound} not found, ${c.error} errors, ${c.pending} still to do.` +
      (running ? ' Running…' : '');
    renderReview();
  }

  async function loadFile() {
    const f = ui.file.files[0];
    if (!f) return;
    if (state && counts().pending && !confirm('Replace the list you already have loaded?')) { ui.file.value = ''; return; }
    const { headers, records } = parseCSV(await f.text());
    const cols = mapColumns(headers);
    if (!cols.name) { alert('Could not find a business name column. Name it "BusinessName" or "Company".'); return; }
    state = {
      fileName: f.name, headers, cols,
      rows: records.map((r) => ({ input: r, result: {}, candidates: [] })),
    };
    saveState(state);
    log(`Loaded ${records.length} rows. Using columns: ` + Object.entries(cols).map(([k, v]) => `${k}=${v}`).join(', '));
    render();
  }

  function inputOf(row) {
    const c = state.cols, r = row.input;
    return { name: r[c.name] || '', address: r[c.address] || '', city: r[c.city] || '', zip: r[c.zip] || '', license: r[c.license] || '', phone: r[c.phone] || '' };
  }

  async function lookupRow(row, delayMs) {
    const input = inputOf(row);
    // Search with the exact name from your list (Inc, LLC and all).
    // Only if that finds nothing, try once more without Inc/LLC/DBA.
    const exact = clean(input.name);
    if (!exact) { row.result = { ic_status: 'skipped' }; return; }
    const loose = searchTermFor(input.name);

    let term = exact;
    let doc = await getDoc(searchPath(term));
    await sleep(delayMs);
    let candidates = isEmployerPage(doc) ? null : parseSearchResults(doc);

    if (candidates && !candidates.length && loose && norm(loose) !== norm(exact)) {
      term = loose;
      doc = await getDoc(searchPath(term));
      await sleep(delayMs);
      candidates = isEmployerPage(doc) ? null : parseSearchResults(doc);
    }
    const via = term === exact ? 'exact name search' : 'search without Inc/LLC ("' + term + '")';

    if (!candidates) { // a single hit may open the report directly
      const emp = parseEmployer(doc);
      row.result = buildResult(input, emp, via + '; only result', ui.src.value.trim());
      return;
    }

    if (!candidates.length) {
      row.result = { ic_status: 'not found', ic_how_matched: 'searched "' + exact + '"' + (term !== exact ? ' and "' + term + '"' : '') };
      return;
    }

    const { pick, scored } = pickCandidate(candidates, input);
    row.candidates = scored.slice(0, 8).map((c) => ({ wcirb: c.wcirb, names: c.names.map((n) => (n.inactive ? '*' : '') + n.text), address: c.address, score: c.score, reasons: c.reasons }));

    if (!pick) {
      row.result = {
        ic_status: 'needs review',
        ic_candidates: row.candidates.map((c) => `${c.wcirb} ${c.names[0] || ''} (${c.address})`).join(' | '),
      };
      return;
    }
    const emp = parseEmployer(await getDoc(employerPath(pick.wcirb)));
    await sleep(delayMs);
    row.result = buildResult(input, emp, via + '; matched on ' + pick.reasons.join(', '), ui.src.value.trim());
  }

  async function start() {
    if (running || !state) return;
    running = true; stopRequested = false; render();
    const delayMs = Math.max(1, Number(ui.delay.value) || CONFIG.defaultDelaySeconds) * 1000;
    const max = Math.max(1, Number(ui.max.value) || CONFIG.defaultMaxRows);
    let done = 0;
    try {
      for (const row of state.rows) {
        if (stopRequested || done >= max) break;
        if (row.result.ic_status) continue;
        const name = inputOf(row).name;
        try {
          await lookupRow(row, delayMs);
          log(`${name}: ${row.result.ic_status}${row.result.ic_current_mod ? ' — mod ' + row.result.ic_current_mod : ''}`);
        } catch (e) {
          if (e instanceof LoggedOutError) {
            log('IntelliComp logged you out. Log back in, then press Run to continue where it stopped.');
            alert('IntelliComp logged you out. Log back in, then press Run — it will pick up where it stopped.');
            break;
          }
          row.result = { ic_status: 'error', ic_how_matched: String(e.message || e) };
          log(`${name}: error — ${e.message || e}`);
        }
        done++;
        saveState(state);
        render();
      }
    } finally {
      running = false;
      saveState(state);
      render();
      log(`Finished this run (${done} looked up).`);
    }
  }

  // Ambiguous rows: you pick the right risk, like you would on the results page
  function renderReview() {
    ui.review.textContent = '';
    if (!state || running) return;
    const items = state.rows.filter((r) => r.result.ic_status === 'needs review');
    if (!items.length) return;
    ui.review.append(el('b', {}, `Pick the right company (${items.length})`));
    items.slice(0, 10).forEach((row, idx) => {
      const input = inputOf(row);
      const group = 'icls_pick_' + idx;
      const box = el('div', { class: 'item' },
        el('div', { class: 'in' }, input.name),
        el('div', { class: 'muted' }, [input.address, input.city, input.zip].filter(Boolean).join(', ') || 'no address in list'));
      row.candidates.forEach((c) => {
        box.append(el('label', {},
          el('input', { type: 'radio', name: group, value: c.wcirb }),
          el('span', {}, `${c.wcirb} — ${c.names.join(' / ')}`, el('br'), el('span', { class: 'muted' }, c.address))));
      });
      box.append(el('label', {}, el('input', { type: 'radio', name: group, value: '' }), el('span', {}, 'None of these')));
      box.append(el('button', {
        onclick: async (ev) => {
          const chosen = box.querySelector(`input[name="${group}"]:checked`);
          if (!chosen) return;
          ev.target.disabled = true;
          if (!chosen.value) {
            row.result = { ic_status: 'not found', ic_how_matched: 'you picked none' };
          } else {
            try {
              const emp = parseEmployer(await getDoc(employerPath(chosen.value)));
              row.result = buildResult(input, emp, 'you picked', ui.src.value.trim());
              log(`${input.name}: found — mod ${row.result.ic_current_mod}`);
            } catch (e) {
              if (e instanceof LoggedOutError) { alert('IntelliComp logged you out. Log back in and pick again.'); ev.target.disabled = false; return; }
              row.result = { ic_status: 'error', ic_how_matched: String(e.message || e) };
            }
          }
          saveState(state);
          render();
        },
      }, 'Use this'));
      ui.review.append(box);
    });
    if (items.length > 10) ui.review.append(el('div', { class: 'muted' }, `${items.length - 10} more after these.`));
  }

  function download() {
    if (!state) return;
    const headers = state.headers.concat(OUTPUT_FIELDS);
    const records = state.rows.map((r) => Object.assign({}, r.input, r.result));
    const blob = new Blob(['﻿' + toCSV(headers, records)], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: state.fileName.replace(/\.csv$/i, '') + '-intellicomp-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  function clearAll() {
    if (!confirm('Clear the loaded list and all results? Download first if you need them.')) return;
    GM_deleteValue(STATE_KEY);
    state = null;
    ui.file.value = '';
    render();
  }

  buildPanel();
})();
