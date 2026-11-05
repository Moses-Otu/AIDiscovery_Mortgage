'use strict';
const root = document.getElementById('root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, ''); else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.problems = data.problems; e.issues = data.issues; throw e; }
  return data;
}
let ov = null;
const show = (...nodes) => root.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false && n !== ''));

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const KIND = { card: 'Playbook card', check: 'Regulatory check', source: 'Source' };
const STATUS = { draft: 'Draft', in_review: 'In review', approved: 'Approved', rejected: 'Changes requested' };

// Field specs: what experts edit, as forms rather than JSON.
const FIELDS = {
  card: [['title', 'Title', 'text'], ['stageId', 'Mortgage stage', 'stage'], ['roles', 'Roles involved', 'roles'], ['signs', 'Signs the problem exists', 'lines'],
    ['interviewQuestions', 'Interview questions', 'lines'], ['infoToCollect', 'Information to collect', 'lines'], ['metrics', 'Metrics', 'lines'],
    ['likelyClassification', 'Likely classification', 'classification'], ['automationPatterns', 'Automation patterns', 'lines'], ['humanApproval', 'Human approval required', 'lines'],
    ['regulatoryLimits', 'Regulatory limits', 'lines'], ['owner', 'Knowledge owner', 'text'], ['sourceRefs', 'Sources (source key | section)', 'refs']],
  check: [['title', 'Title', 'text'], ['statement', 'What the rule says', 'textarea'], ['appliesToStages', 'Applies at these stages', 'stages'],
    ['appliesTo', 'Applies to', 'appliesTo'], ['requiredAction', 'What must happen before any change', 'textarea'], ['owner', 'Knowledge owner', 'text'], ['sourceRefs', 'Sources (source key | section)', 'refs']],
  source: [['title', 'Title', 'text'], ['reference', 'Reference or URL', 'text'], ['publisher', 'Publisher', 'text'], ['updatedOn', 'Published or updated on', 'date'],
    ['sections', 'Relevant sections', 'lines'], ['summary', 'Summary (in your words)', 'textarea'], ['owner', 'Knowledge owner', 'text']],
};

function input(type, name, value) {
  const m = ov.meta;
  if (type === 'text' || type === 'date') return el('input', { name, type, value: value ?? '' });
  if (type === 'textarea' || type === 'lines' || type === 'refs') {
    const t = el('textarea', { name, rows: type === 'textarea' ? '4' : '3' });
    t.value = type === 'lines' ? (value || []).join('\n') : type === 'refs' ? (value || []).map((r) => `${r.sourceKey}${r.section ? ` | ${r.section}` : ''}`).join('\n') : (value ?? '');
    return t;
  }
  const select = (opts) => el('select', { name }, ...opts.map(([v, l]) => el('option', { value: v, selected: v === value }, l)));
  if (type === 'stage') return select(m.stages.map((s) => [s.id, s.name]));
  if (type === 'classification') return select(m.classifications.map((c) => [c, c.replace('_', ' ')]));
  if (type === 'appliesTo') return select([['any_change', 'Any change at the stage'], ['automation', 'Automation only']]);
  const opts = type === 'roles' ? m.roles.map((r) => [r.id, r.name]) : m.stages.map((s) => [s.id, s.name + (s.regulated ? ' (regulated)' : '')]);
  return el('div', { 'data-name': name }, ...opts.map(([v, l]) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: (value || []).includes(v) }), l)));
}
function read(form, kind) {
  const out = {};
  for (const [name, , type] of FIELDS[kind]) {
    if (type === 'roles' || type === 'stages') { out[name] = [...form.querySelectorAll(`[data-name=${name}] input:checked`)].map((i) => i.value); continue; }
    const v = form.elements[name].value;
    if (type === 'lines') out[name] = v.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (type === 'refs') out[name] = v.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...rest] = x.split('|'); return { sourceKey: k.trim(), section: rest.join('|').trim() }; });
    else out[name] = v;
  }
  return out;
}

function editor(kind, key, content, suggestedKey) {
  const keyInput = el('input', { name: '__key', value: key || suggestedKey || '', required: true, readonly: key ? true : false, placeholder: 'e.g. document_chasing or fca-mcob-4' });
  const out = el('p', { class: 'status', role: 'status' });
  const form = el('form', { class: 'review', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const saved = await api('/api/knowledge/drafts', 'POST', { kind, key: keyInput.value.trim(), content: read(form, kind) });
      itemView(saved.id);
    } catch (err) { out.textContent = err.issues ? `${err.message} ${err.issues.map((i) => `${i.path.replace('content.', '')}: ${i.message}`).join('; ')}` : err.message; }
  } },
    el('h2', {}, `${key ? 'Edit' : 'New'} ${KIND[kind].toLowerCase()}`),
    el('label', { class: 'field' }, 'Key', keyInput),
    ...FIELDS[kind].map(([name, label, type]) => el('label', { class: 'field' }, label, input(type, name, content?.[name]))),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save draft'), el('button', { class: 'btn', type: 'button', onclick: home }, 'Cancel')), out);
  show(form);
}

async function itemView(id) {
  const { item, changes, history } = await api(`/api/knowledge/items/${id}`);
  const mine = item.authorId === ov.userId;
  const reviewer = ov.roles.includes('compliance_reviewer');
  const note = el('textarea', { placeholder: 'Review note (required when requesting changes)' });
  const out = el('p', { class: 'status', role: 'status' });
  const act = (fn) => async () => { try { await fn(); await load(); itemView(id); } catch (err) { out.textContent = err.message; } };
  const label = (f) => (FIELDS[item.kind].find((x) => x[0] === f) || [f, f])[1];
  show(
    el('p', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); home(); } }, 'Knowledge base')),
    el('h1', {}, item.content.title || item.key),
    el('p', { class: 'muted' }, `${KIND[item.kind]} “${item.key}”, version ${item.version}. ${STATUS[item.status]}.${mine ? ' You wrote this version.' : ''}`),
    item.reviewNote && el('p', { class: 'notice' }, `Reviewer’s note: ${item.reviewNote}`),
    el('h2', {}, changes.length ? 'Changes since the last approved version' : 'No changes since the last approved version'),
    changes.length > 0 && el('dl', { class: 'facts diff' }, ...changes.flatMap((c) => [el('dt', {}, label(c.field)), el('dd', {},
      ...(c.added || c.removed
        ? [...(c.added || []).map((x) => el('div', { class: 'add' }, `Added: ${x}`)), ...(c.removed || []).map((x) => el('div', { class: 'del' }, `Removed: ${x}`))]
        : [el('div', { class: 'del' }, c.before ? `Before: ${c.before}` : 'Before: (empty)'), el('div', { class: 'add' }, `Now: ${c.after}`)]))])),
    el('div', { class: 'actions' },
      (item.status !== 'in_review' && (item.status !== 'draft' || mine)) && el('button', { class: 'btn', onclick: () => editor(item.kind, item.key, item.content) }, item.status === 'draft' ? 'Edit draft' : 'Start a new version'),
      item.status === 'draft' && mine && el('button', { class: 'btn btn-primary', onclick: act(() => api(`/api/knowledge/items/${id}/submit`, 'POST')) }, 'Submit for review')),
    item.status === 'in_review' && reviewer && !mine && el('div', { class: 'decision' }, el('h3', {}, 'Your review'), note,
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', onclick: act(() => api(`/api/knowledge/items/${id}/review`, 'POST', { decision: 'approve', note: note.value })) }, 'Approve'),
        el('button', { class: 'btn', onclick: act(() => api(`/api/knowledge/items/${id}/review`, 'POST', { decision: 'reject', note: note.value })) }, 'Request changes'))),
    item.status === 'in_review' && mine && el('p', { class: 'muted' }, 'Waiting for a compliance reviewer other than you.'),
    out,
    el('h2', {}, 'History'),
    el('ul', { class: 'list-plain' }, ...history.map((h) => el('li', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); itemView(h.id); } }, `Version ${h.version}`), ` — ${STATUS[h.status]}${h.reviewedAt ? `, reviewed ${new Date(h.reviewedAt).toLocaleDateString('en-GB')}` : ''}`))));
}

async function load() { ov = await api('/api/knowledge'); }

async function home() {
  await load();
  const [preview, cand] = await Promise.all([api('/api/knowledge/release-preview'), api('/api/knowledge/candidates')]);
  const editorRole = ov.roles.includes('knowledge_editor');
  const notes = el('input', { placeholder: 'What changed in this release' });
  const out = el('p', { class: 'status', role: 'status' });
  const group = (kind) => ov.items.filter((i) => i.kind === kind);
  const row = (i) => el('li', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); itemView(i.latest.id); } }, i.title), ' ',
    el('span', { class: 'tag' + (i.latest.status === 'in_review' ? ' warn' : '') }, `${STATUS[i.latest.status]} v${i.latest.version}`),
    i.approvedVersion && i.approvedVersion !== i.latest.version ? el('span', { class: 'muted' }, ` (approved: v${i.approvedVersion})`) : null);
  show(
    el('h1', {}, 'Knowledge base'),
    el('p', { class: 'muted' }, `Your roles: ${ov.roles.map((r) => r.replace('_', ' ')).join(', ')}. Every change is reviewed by a compliance reviewer other than its author before it can be published.`),
    el('h2', {}, 'Next release'),
    el('div', { class: 'decision' },
      el('p', {}, `Approved so far: ${plural(preview.counts.cards, 'card')}, ${plural(preview.counts.checks, 'regulatory check')} and ${plural(preview.counts.sources, 'source')}.`),
      preview.problems.length ? el('div', {}, el('p', {}, 'Before publishing:'), el('ul', {}, ...preview.problems.map((p) => el('li', {}, p))))
        : el('p', {}, 'Ready to publish. New discoveries will use this release; discoveries already running keep theirs.'),
      editorRole && !preview.problems.length && el('div', { class: 'actions' }, notes, el('button', { class: 'btn btn-primary', onclick: async () => {
        try { const r = await api('/api/knowledge/releases', 'POST', { notes: notes.value }); out.textContent = `Published release ${r.version}.`; setTimeout(home, 800); } catch (err) { out.textContent = err.problems ? err.problems.join(' ') : err.message; }
      } }, 'Publish release')), out,
      ov.releases.length > 0 && el('p', { class: 'muted' }, `Published: ${ov.releases.map((r) => r.version).join(', ')}`)),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => editor('card') }, 'New card'),
      el('button', { class: 'btn', onclick: () => editor('check') }, 'New regulatory check'),
      el('button', { class: 'btn', onclick: () => editor('source') }, 'New source'),
      editorRole && group('card').length === 0 && el('button', { class: 'btn', onclick: async () => { await api('/api/knowledge/import-seed', 'POST'); home(); } }, 'Import the draft seed cards')),
    ...['card', 'check', 'source'].flatMap((k) => [el('h2', {}, `${KIND[k]}s`), group(k).length ? el('ul', { class: 'list-plain' }, ...group(k).map(row)) : el('p', { class: 'muted' }, 'None yet.')]),
    el('h2', {}, 'Seen in discoveries, not in the playbook'),
    cand.candidates.length === 0 ? el('p', { class: 'muted' }, 'Nothing yet. Items appear here once at least two firms have raised them.') :
      el('ul', { class: 'list-plain' }, ...cand.candidates.map((c) => el('li', {}, `${c.title} `, el('span', { class: 'muted' }, `(${c.firms} firms)`), ' ',
        el('button', { class: 'btn', onclick: () => editor('card', null, { title: c.title, stageId: c.stageId, roles: [], signs: [], interviewQuestions: [], infoToCollect: [], metrics: [], automationPatterns: [], humanApproval: [], regulatoryLimits: [], owner: '', sourceRefs: [] }, c.key) }, 'Draft a card')))));
}

home().catch((err) => root.replaceChildren(el('h1', {}, 'Knowledge base'), el('p', {}, err.message)));
