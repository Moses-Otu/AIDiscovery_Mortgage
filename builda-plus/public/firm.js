'use strict';
const discoveryId = location.pathname.split('/').pop();
const base = `/api/firm/discoveries/${discoveryId}`;
const root = document.getElementById('root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};
const CLASS_LABEL = { overhaul: 'Overhaul', fix: 'Fix', automate: 'Automate', keep_human: 'Keep human' };
const CONF_LABEL = { insufficient: 'Not enough evidence', low: 'Low', medium: 'Medium', high: 'High', very_high: 'Very high' };
const n1 = (x) => (x === null || x === undefined ? 'Unknown' : Number(x).toLocaleString('en-GB', { maximumFractionDigits: 1 }));
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const status = el('p', { class: 'status', role: 'status' });
async function run(label, fn) {
  status.textContent = `${label}…`;
  try { render(await fn()); status.textContent = `${label} — done.`; } catch (err) { status.textContent = err.message; }
}

function linkRow(name, link) {
  const input = el('input', { value: link, readonly: '', 'aria-label': `Follow-up link for ${name}` });
  const note = el('span', { class: 'muted', role: 'status' });
  return el('div', { class: 'link-box' }, el('p', {}, el('strong', {}, name)),
    el('div', { class: 'link-row' }, input, el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(link); note.textContent = 'Copied.'; } catch { input.select(); note.textContent = 'Press Ctrl+C (or Cmd+C) to copy.'; }
    } }, 'Copy link')), note);
}

function facts(pairs) { return el('dl', { class: 'facts' }, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }

function correctionForm(p) {
  const field = el('select', { name: 'field' },
    ...[['classification', 'Classification'], ['monthlyVolume', 'Monthly volume'], ['minutesPerOccurrence', 'Minutes each time'], ['reductionPct', 'Reduction (%)'], ['title', 'Title'], ['validated', 'Confirm this finding']]
      .map(([v, l]) => el('option', { value: v }, l)));
  const value = el('input', { name: 'value', placeholder: 'New value (blank clears a figure)' });
  const reason = el('input', { name: 'reason', placeholder: 'Reason', required: '' });
  return el('form', { class: 'correct', onsubmit: (e) => {
    e.preventDefault();
    const f = field.value; let v = value.value.trim();
    if (['monthlyVolume', 'minutesPerOccurrence'].includes(f)) v = v === '' ? null : Number(v);
    else if (f === 'reductionPct') v = v === '' ? null : Number(v) / 100;
    else if (f === 'validated') v = v.toLowerCase() !== 'no';
    else if (f === 'classification') v = v.toLowerCase().replace(' ', '_');
    run('Saving correction', () => api(`${base}/pain-points/${p.id}/corrections`, 'POST', { field: f, value: v, reason: reason.value || 'Confirmed' }));
  } },
    el('label', {}, 'Correct', field), el('label', {}, 'Value', value), el('label', {}, 'Why', reason),
    el('button', { class: 'btn', type: 'submit' }, 'Save correction'));
}

function painPointDetail(p) {
  const hours = p.impact ? p.impact.monthlyHoursRecovered : null;
  return el('details', { class: 'finding', id: `pp-${p.id}` },
    el('summary', {}, `${p.title} `, el('span', { class: 'muted' }, `· ${p.stageName}`)),
    el('div', { class: 'chips' },
      el('span', { class: 'tag' }, p.classification ? CLASS_LABEL[p.classification] : 'Not classified'),
      el('span', { class: 'tag' }, `Evidence: ${CONF_LABEL[p.confidence] || p.confidence}`),
      p.requiresComplianceReview && el('span', { class: 'tag warn' }, 'Needs compliance review'),
      p.validated && el('span', { class: 'tag' }, 'Confirmed by you')),
    facts([
      ['Reported by', `${p.roles.join(', ') || '—'} (${p.participantCount} ${p.participantCount === 1 ? 'person' : 'people'})`],
      ['Monthly volume', p.overrides.monthlyVolume !== undefined ? `${n1(p.overrides.monthlyVolume)} (your correction)` : n1(p.volume && p.volume.value)],
      ['Minutes each time', p.overrides.minutesPerOccurrence !== undefined ? `${n1(p.overrides.minutesPerOccurrence)} (your correction)` : n1(p.minutes && p.minutes.value)],
      ['Hours spent / month', n1(p.impact && p.impact.monthlyHoursSpent)],
      ['Hours recoverable / month', n1(hours)],
    ]),
    p.classificationRationale && el('p', {}, p.classificationRationale),
    p.disagreements.length > 0 && el('div', {}, el('h4', {}, 'Where accounts differ'),
      el('ul', {}, ...p.disagreements.map((d) => el('li', {}, `${d.field === 'minutesPerOccurrence' ? 'Minutes each time' : 'Monthly volume'}: ${d.values.map((v) => `${v.role} ${n1(v.value)}`).join(', ')}`)))),
    p.quotes.length > 0 && el('div', {}, el('h4', {}, 'What people said'), ...p.quotes.slice(0, 6).map((q) => el('blockquote', {}, `“${q.quote}” `, el('span', { class: 'muted' }, `— ${q.role}`)))),
    p.assumptions.length > 0 && el('div', {}, el('h4', {}, 'Assumptions'), el('ul', {}, ...p.assumptions.map((a) => el('li', {}, a)))),
    p.missingMeasurements.length > 0 && el('p', { class: 'muted' }, 'Missing figures — follow-up questions can fill these in.'),
    p.explanation.length > 0 && el('div', {}, el('h4', {}, 'Why it ranks above the next item'), el('ul', {}, ...p.explanation.map((x) => el('li', {}, x)))),
    p.twoWeek && el('div', {}, el('h4', {}, 'Two-week build'),
      el('p', {}, p.twoWeek.status === 'provisional' ? 'Provisionally eligible, subject to JADA engineering review.' : 'Not yet eligible:'),
      p.twoWeek.blockers && p.twoWeek.blockers.length > 0 && el('ul', {}, ...p.twoWeek.blockers.map((b) => el('li', {}, b)))),
    p.corrections.length > 0 && el('div', {}, el('h4', {}, 'Your corrections'),
      el('ul', {}, ...p.corrections.map((c) => el('li', {}, `${c.field}: ${JSON.stringify(c.old_value)} → ${JSON.stringify(c.new_value)} (${c.reason})`)))),
    correctionForm(p));
}

let packs = [];
async function loadPacks() { try { packs = (await api(`${base}/implementation`)).packs; } catch { packs = []; } }
const PACK_STATUS = { in_review: 'With JADA engineering for review', needs_changes: 'JADA needs some things resolved first', confirmed: 'Two-week build confirmed' };

function decisionSection(pb, byId) {
  const automate = pb.topThree.map((id) => byId.get(id)).filter((p) => p.classification === 'automate');
  const checks = pb.topThree.map((id) => {
    const box = el('input', { type: 'checkbox', value: id, checked: '' });
    return { id, box, label: el('label', {}, box, byId.get(id).title) };
  });
  const choice = el('select', { 'aria-label': 'What to build first' },
    el('option', { value: '' }, 'Not yet — just approve the priorities'),
    ...automate.map((p) => el('option', { value: p.id }, p.title)));
  const note = el('textarea', { placeholder: 'Anything JADA should know (optional)' });
  const reportStatus = el('p', { class: 'status', role: 'status' });
  return el('section', {},
    el('h2', {}, 'Report and next step'),
    el('div', { class: 'decision' },
      el('p', {}, 'Download a PDF of these findings to share. Each download is saved as a fixed version, so you can compare against it after changes are made.'),
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: async () => {
        reportStatus.textContent = 'Preparing the report…';
        try { const r = await api(`${base}/reports`, 'POST'); location.href = r.pdfUrl; reportStatus.textContent = `Report version ${r.version} downloaded.`; }
        catch (err) { reportStatus.textContent = err.message; }
      } }, 'Download report (PDF)')),
      reportStatus,
      pb.topThree.length > 0 && el('div', {},
        el('h3', {}, 'Approve your priorities'),
        el('p', { class: 'muted' }, 'Untick anything you don’t agree should be a priority. Approving confirms these findings.'),
        ...checks.map((c) => c.label),
        el('label', {}, 'Build first: ', choice),
        note,
        el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', onclick: () => run('Approving priorities', async () => {
          const priorities = checks.filter((c) => c.box.checked).map((c) => c.id);
          await api(`${base}/approve`, 'POST', { priorities, proceedWith: choice.value || null, note: note.value });
          await loadPacks();
          return api(`${base}/playback`);
        }) }, 'Approve priorities'))),
      packs.length > 0 && el('div', {}, el('h3', {}, 'Implementation'),
        el('ul', {}, ...packs.map((k) => el('li', {}, `${k.title}: ${PACK_STATUS[k.status] || k.status}`,
          k.failures.length ? el('ul', {}, ...k.failures.map((f) => el('li', { class: 'muted' }, f))) : null))))));
}

function render(pb) {
  const byId = new Map(pb.painPoints.map((p) => [p.id, p]));
  const done = pb.participation.filter((p) => p.status === 'completed').length;
  root.replaceChildren(
    el('h1', {}, 'Discovery findings'),
    el('p', { class: 'muted' }, `${done} of ${pb.participation.length} interviews complete. ${pb.analysedAt ? `Last analysed ${new Date(pb.analysedAt).toLocaleString('en-GB')}.` : 'Not analysed yet.'}`),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-primary', onclick: () => run('Analysing interviews', () => api(`${base}/analyse`, 'POST')) }, 'Analyse interviews'),
      el('button', { class: 'btn', onclick: async () => {
        status.textContent = 'Preparing follow-up questions…';
        try {
          const r = await api(`${base}/follow-ups`, 'POST');
          if (!r.links.length) { status.textContent = 'No follow-up questions needed right now.'; return; }
          status.replaceChildren(
            el('span', {}, `${r.questions} short follow-up question${r.questions === 1 ? '' : 's'} for ${r.participants} ${r.participants === 1 ? 'person' : 'people'}. Send each person their new link — their old link no longer works.`),
            ...r.links.map((l) => linkRow(l.name, l.link)));
        } catch (err) { status.textContent = err.message; }
      } }, 'Prepare follow-up questions'),
      el('button', { class: 'btn', onclick: () => run('Asking JADA to get in touch', async () => { await api(`${base}/help`, 'POST', { note: 'Firm lead requested help from playback' }); return api(`${base}/playback`); }) }, 'Ask JADA for help')),
    status,
    pb.painPoints.length === 0 ? el('p', {}, 'No findings yet. Once interviews are complete, choose “Analyse interviews”.') : el('div', {},
      el('h2', {}, 'Top opportunities'),
      el('ol', { class: 'top3' }, ...pb.topThree.map((id) => byId.get(id)).map((p) => el('li', {},
        el('h3', {}, p.title),
        facts([['Stage', p.stageName], ['Approach', CLASS_LABEL[p.classification] || '—'], ['Hours recoverable / month', n1(p.impact && p.impact.monthlyHoursRecovered)], ['Evidence', CONF_LABEL[p.confidence]]]),
        el('p', {}, el('a', { href: `#pp-${p.id}` }, 'See the detail'))))),
      el('h2', {}, 'Your mortgage journey'),
      el('ol', { class: 'journey-map' }, ...pb.journey.map((s) => el('li', {},
        el('span', {}, s.name, s.regulatedJudgement && el('span', { class: 'reg' }, 'Adviser judgement — preparation only')),
        el('div', { class: 'chips' }, ...s.painPoints.map((id) => el('a', { class: 'chip', href: `#pp-${id}` }, byId.get(id).title)))))),
      pb.crossRole && el('div', {},
        el('h2', {}, 'Across roles'),
        facts([
          ['Agreed by several people', pb.crossRole.agreements.length ? pb.crossRole.agreements.map((k) => (pb.painPoints.find((p) => p.key === k) || { title: k }).title).join('; ') : 'None yet'],
          ['Accounts differ', pb.crossRole.disagreements.length ? pb.crossRole.disagreements.map((k) => (pb.painPoints.find((p) => p.key === k) || { title: k }).title).join('; ') : 'None'],
          ['Raised by staff, not by you', !pb.crossRole.firmLeadInterviewed ? 'Complete your own interview to see this' : pb.crossRole.blindSpots.length ? pb.crossRole.blindSpots.map((k) => (pb.painPoints.find((p) => p.key === k) || { title: k }).title).join('; ') : 'None'],
          ['Stages nobody described', pb.crossRole.unreportedStages.join(', ') || 'None'],
        ])),
      decisionSection(pb, byId),
      el('h2', {}, 'All findings'),
      ...pb.painPoints.map(painPointDetail)));
}

(async () => { try { await loadPacks(); render(await api(`${base}/playback`)); } catch (err) { status.textContent = err.message; root.replaceChildren(el('h1', {}, 'Discovery findings'), status); } })();
