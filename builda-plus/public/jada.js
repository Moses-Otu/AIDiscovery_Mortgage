'use strict';
const root = document.getElementById('root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const list = (xs) => el('ul', {}, ...(xs.length ? xs : ['None']).map((x) => el('li', {}, x)));
const PACK_STATUS = { in_review: 'Waiting for review', needs_changes: 'Needs changes', confirmed: 'Two-week build confirmed' };
const REASONS = { client_information: 'Client information typed', complaint_or_compliance: 'Complaint or compliance concern', employment_issue: 'Staff or employment matter',
  advice_request: 'Asked for mortgage advice', out_of_scope: 'Outside scope', firm_lead_requested: 'Firm lead asked for help', insufficient_evidence: 'Not enough evidence' };

async function listView() {
  const [{ discoveries }, { queue }] = await Promise.all([api('/api/jada/discoveries'), api('/api/jada/queue').catch(() => ({ queue: [] }))]);
  const out = el('p', { class: 'status', role: 'status' });
  root.replaceChildren(
    el('h1', {}, 'JADA work'),
    el('h2', {}, 'Waiting for an engineer'),
    queue.length === 0 ? el('p', { class: 'muted' }, 'Nothing waiting. Firms appear here when they approve priorities or ask for help.') :
      el('ul', { class: 'list-plain' }, ...queue.map((q) => el('li', {}, el('strong', {}, q.firmName), ' ', el('span', { class: 'muted' }, q.reason), ' ',
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try { await api(`/api/jada/discoveries/${q.discoveryId}/pick-up`, 'POST'); location.href = `/jada/discoveries/${q.discoveryId}`; } catch (err) { out.textContent = err.message; }
        } }, 'Pick this up')))),
    out,
    el('h2', {}, 'Yours'),
    discoveries.length === 0 ? el('p', { class: 'muted' }, 'You haven’t picked anything up yet.') :
    el('ul', { class: 'list-plain' }, ...discoveries.map((d) => el('li', {},
      el('a', { href: `/jada/discoveries/${d.id}` }, d.firmName), ' ',
      el('span', { class: 'muted' }, `${d.packsToReview} pack${d.packsToReview === 1 ? '' : 's'} to review, ${d.openEscalations} open escalation${d.openEscalations === 1 ? '' : 's'}`)))));
}

function reviewForm(pack, refresh) {
  const box = (name, label) => { const b = el('input', { type: 'checkbox', name }); return { name, b, node: el('label', {}, b, label) }; };
  const items = [
    box('singleWorkflowWithStartAndFinish', 'One workflow with a clear start and finish'),
    box('accessAndTestDataReadyDayOne', 'Access and test data are ready for day one'),
    box('humanApprovalForCommsAndRecordChanges', 'People approve every communication and record change'),
    box('complianceQuestionsResolved', 'Compliance questions are resolved'),
  ];
  const core = el('input', { type: 'checkbox', name: 'changesCoreSystems' });
  const deps = el('textarea', { placeholder: 'Unresolved dependencies, one per line' });
  const notes = el('textarea', { placeholder: 'Notes for the record' });
  const out = el('p', { class: 'status', role: 'status' });
  return el('form', { class: 'review', onsubmit: async (e) => {
    e.preventDefault();
    const checks = Object.fromEntries(items.map((i) => [i.name, i.b.checked]));
    checks.changesCoreSystems = core.checked;
    try {
      const r = await api(`/api/jada/packs/${pack.id}/reviews`, 'POST', { checks, unresolvedDependencies: deps.value.split('\n').map((x) => x.trim()).filter(Boolean), notes: notes.value });
      out.textContent = r.decision === 'confirmed' ? 'Confirmed. The two-week clock starts now that prerequisites are ready.' : `Needs changes: ${r.failures.join('; ')}`;
      setTimeout(refresh, 900);
    } catch (err) { out.textContent = err.message; }
  } },
    el('fieldset', {}, el('legend', {}, 'Engineering checks'), ...items.map((i) => i.node), el('label', {}, core, 'This needs changes to the firm’s core systems')),
    deps, notes, el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Record review')), out);
}

function packView(pack, refresh) {
  const c = pack.content;
  const b = c.baseline;
  return el('article', { class: 'pack' },
    el('h3', {}, c.painPoint.title),
    el('p', { class: 'muted' }, `${c.painPoint.stage}. Evidence: ${c.painPoint.confidence}. Template: ${c.template ? `${c.template.name}${c.template.tested ? '' : ' (not yet tested)'}` : 'none'}. Status: ${PACK_STATUS[pack.status] || pack.status}.`),
    el('p', {}, el('a', { href: `/api/jada/packs/${pack.id}/markdown` }, 'Download as Markdown')),
    el('h4', {}, 'Scope'), el('p', {}, c.scope.workflow),
    el('h4', {}, 'Current process'), list(c.currentProcess.facts),
    el('h4', {}, 'Baseline'), list([`Monthly volume: ${b.monthlyVolume ?? 'unknown'}`, `Minutes each time: ${b.minutesPerOccurrence ?? 'unknown'}`, `Staff hours per month: ${b.monthlyHoursSpent ?? 'unknown'}`]),
    el('h4', {}, 'Target process'), el('ol', {}, ...c.targetProcess.map((s) => el('li', {}, s))),
    el('h4', {}, 'Systems'), list(c.systems),
    el('h4', {}, 'Access requirements'), list(c.accessRequirements),
    el('h4', {}, 'Firm rules'), list(c.firmRules),
    el('h4', {}, 'Automation requirements'), list(c.automationRequirements),
    el('h4', {}, 'Human approval points'), list(c.humanApprovalPoints),
    el('h4', {}, `Regulatory checks (knowledge ${c.knowledge ? c.knowledge.version : 'unknown'}${c.knowledge && !c.knowledge.reviewed ? ', unreviewed' : ''})`),
    list((c.regulatoryChecks || []).map((r) => `${r.title}: ${r.requiredAction}${r.citations.length ? ` (Source: ${r.citations.join('; ')})` : ''}`)),
    el('h4', {}, 'Stays with people'), list(c.keepWithPeople),
    el('h4', {}, 'Test cases'), list(c.testCases.map((t) => `${t.name}: given ${t.given.toLowerCase()}, when ${t.when.toLowerCase()}, then ${t.then.toLowerCase()}.`)),
    el('h4', {}, 'Definition of done'), list(c.definitionOfDone),
    el('h4', {}, 'Risks'), list(c.risks),
    el('h4', {}, 'Dependencies'), list(c.dependencies),
    el('h4', {}, 'Assumptions'), list(c.assumptions),
    el('h4', {}, 'Open questions'), list(c.openQuestions),
    pack.reviews.length > 0 && el('div', {}, el('h4', {}, 'Review history'),
      list(pack.reviews.map((r) => `${new Date(r.at).toLocaleString('en-GB')}: ${r.decision === 'confirmed' ? 'confirmed' : `needs changes (${r.failures.join('; ')})`}${r.notes ? ` — ${r.notes}` : ''}`))),
    pack.status !== 'confirmed' && reviewForm(pack, refresh));
}

async function discoveryView(id) {
  const d = await api(`/api/jada/discoveries/${id}`);
  const refresh = () => discoveryView(id);
  root.replaceChildren(
    el('p', {}, el('a', { href: '/jada' }, 'JADA work')),
    el('h1', {}, d.firmName),
    el('h2', {}, 'Escalations'),
    d.escalations.length === 0 ? el('p', {}, 'None.') : el('ul', { class: 'list-plain' }, ...d.escalations.map((e) => el('li', {},
      el('strong', {}, REASONS[e.reason] || e.reason), ' ', el('span', { class: 'muted' }, new Date(e.createdAt).toLocaleString('en-GB')),
      el('p', {}, e.detail || ''),
      e.status === 'open' ? el('button', { class: 'btn', onclick: async () => { await api(`/api/jada/escalations/${e.id}/resolve`, 'POST', { note: '' }); refresh(); } }, 'Mark resolved') : el('span', { class: 'muted' }, 'Resolved')))),
    el('h2', {}, 'Implementation packs'),
    d.packs.length === 0 ? el('p', {}, 'The firm lead hasn’t chosen anything to build yet.') : el('div', {}, ...d.packs.map((p) => packView(p, refresh))));
}

(async () => {
  try {
    const m = location.pathname.match(/^\/jada\/discoveries\/([0-9a-f-]{36})$/);
    if (m) await discoveryView(m[1]); else await listView();
  } catch (err) { root.replaceChildren(el('h1', {}, 'JADA engineering'), el('p', {}, err.message)); }
})();
