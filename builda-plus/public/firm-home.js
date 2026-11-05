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
const show = (...nodes) => root.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/'; throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error(data.issues ? `Please check: ${data.issues.map((i) => i.path || 'form').join(', ')}.` : (data.error || 'Something went wrong.'));
  return data;
}
const ROLES = [['firm_lead', 'Firm owner / Managing Director'], ['adviser', 'Mortgage adviser'], ['case_manager', 'Case manager'], ['administrator', 'Administrator'], ['other', 'Other operational staff']];
const STATUS = { invited: 'Not opened yet', opened: 'Opened the link', consented: 'Agreed, not started', in_progress: 'In progress', paused: 'Paused', completed: 'Finished', escalated: 'Paused — JADA following up' };
const DSTATUS = { profile: 'Firm profile needed', interviews: 'Interviews', priorities_approved: 'Priorities approved' };

function linkBox(name, link) {
  const input = el('input', { value: link, readonly: true, 'aria-label': `Interview link for ${name}` });
  const copied = el('span', { class: 'muted', role: 'status' });
  return el('div', { class: 'link-box' },
    el('p', {}, el('strong', {}, `Link for ${name}. `), 'Copy it now and send it to them however suits you. For security it can’t be shown again, but you can always make a new one.'),
    el('div', { class: 'link-row' }, input, el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(link); copied.textContent = 'Copied.'; } catch { input.select(); copied.textContent = 'Press Ctrl+C (or Cmd+C) to copy.'; }
    } }, 'Copy link')), copied);
}

async function home() {
  const { discoveries } = await api('/api/firm/discoveries');
  const status = el('p', { class: 'status', role: 'status' });
  show(
    el('h1', {}, 'Your discoveries'),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', onclick: async () => {
      try { const { discoveryId } = await api('/api/firm/discoveries', 'POST'); location.search = `?d=${discoveryId}`; } catch (err) { status.textContent = err.message; }
    } }, 'Start a new discovery')),
    status,
    discoveries.length === 0 ? el('p', {}, 'Start a discovery to map how work moves through your firm. You’ll fill in a short profile, then add the people to interview.') :
      el('ul', { class: 'list-plain' }, ...discoveries.map((d) => el('li', {},
        el('strong', {}, `Started ${new Date(d.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`), ' ',
        el('span', { class: 'muted' }, `${DSTATUS[d.status] || d.status}. ${d.completed} of ${d.people} interviews finished.`),
        el('div', { class: 'actions' },
          el('a', { class: 'btn', href: `?d=${d.id}` }, d.hasProfile ? 'Manage people' : 'Fill in the profile'),
          d.completed > 0 && el('a', { class: 'btn', href: `/firm/discoveries/${d.id}` }, 'See findings'))))));
}

function profileForm(id, p) {
  const v = (k) => (p && p[k] !== null && p[k] !== undefined ? String(p[k]) : '');
  const count = (role) => String((p?.staffRoles || []).find((r) => r.role === role)?.count ?? '');
  const f = {
    advisers: el('input', { type: 'number', min: '0', value: v('advisers'), required: true }),
    monthlyApplications: el('input', { type: 'number', min: '0', value: v('monthlyApplications') }),
    typicalWeeksEnquiryToOffer: el('input', { type: 'number', min: '0', step: '0.5', value: v('typicalWeeksEnquiryToOffer') }),
    authorisation: el('select', {}, ...[['directly_authorised', 'Directly authorised'], ['network_appointed_representative', 'Appointed representative of a network'], ['unsure', 'Not sure']]
      .map(([val, label]) => el('option', { value: val, selected: p?.authorisation === val }, label))),
    systems: el('input', { value: (p?.systems || []).join(', '), placeholder: 'e.g. CRM, sourcing system, lender portals' }),
    businessStructure: el('input', { value: v('businessStructure'), placeholder: 'e.g. one office, advisers supported by a case team' }),
    operationalChallenges: el('textarea', {}, v('operationalChallenges')),
    loadedHourlyCostGBP: el('input', { type: 'number', min: '0', step: '0.5', value: v('loadedHourlyCostGBP'), placeholder: 'Optional' }),
  };
  const counts = { case_manager: el('input', { type: 'number', min: '0', value: count('case_manager') }), administrator: el('input', { type: 'number', min: '0', value: count('administrator') }) };
  const status = el('p', { class: 'status', role: 'status' });
  const num = (x) => (x.value === '' ? null : Number(x.value));
  const field = (label, input, hint) => el('label', { class: 'field' }, label, input, hint && el('span', { class: 'muted small' }, hint));
  return el('form', { class: 'review', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/api/firm/discoveries/${id}/profile`, 'PUT', {
        advisers: Number(f.advisers.value || 0), monthlyApplications: num(f.monthlyApplications), typicalWeeksEnquiryToOffer: num(f.typicalWeeksEnquiryToOffer),
        authorisation: f.authorisation.value, systems: f.systems.value.split(',').map((x) => x.trim()).filter(Boolean),
        businessStructure: f.businessStructure.value, operationalChallenges: f.operationalChallenges.value, loadedHourlyCostGBP: num(f.loadedHourlyCostGBP),
        staffRoles: [{ role: 'adviser', count: Number(f.advisers.value || 0) }, ...Object.entries(counts).map(([role, i]) => ({ role, count: Number(i.value || 0) }))],
      });
      status.textContent = 'Profile saved.';
    } catch (err) { status.textContent = err.message; }
  } },
    el('h2', {}, 'Your firm'),
    el('div', { class: 'grid2' },
      field('Advisers', f.advisers), field('Case managers', counts.case_manager), field('Administrators', counts.administrator),
      field('Mortgage applications a month', f.monthlyApplications), field('Typical weeks from enquiry to offer', f.typicalWeeksEnquiryToOffer), field('Authorisation', f.authorisation)),
    field('Systems you use', f.systems, 'Separate with commas.'),
    field('How the firm is set up', f.businessStructure),
    field('What slows things down today?', f.operationalChallenges),
    field('Approximate hourly cost of an administrator, in £', f.loadedHourlyCostGBP, 'Only used to put a value on time saved. Leave blank if you’d rather not say.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile')), status);
}

async function manage(id) {
  const [{ profile }, { participants }] = await Promise.all([api(`/api/firm/discoveries/${id}/profile`), api(`/api/firm/discoveries/${id}/progress`)]);
  const links = el('div', {});
  const name = el('input', { placeholder: 'Their name', required: true });
  const role = el('select', {}, ...ROLES.map(([v, l]) => el('option', { value: v }, l)));
  const status = el('p', { class: 'status', role: 'status' });
  show(
    el('p', {}, el('a', { href: '/firm' }, 'Your discoveries')),
    el('h1', {}, 'Set up the discovery'),
    profileForm(id, profile),
    el('section', {},
      el('h2', {}, 'People to interview'),
      el('p', { class: 'muted' }, 'Include two or three senior advisers and at least one case manager or administrator. Add yourself too — your view is compared with your team’s.'),
      participants.length ? el('ul', { class: 'list-plain' }, ...participants.map((p) => el('li', {},
        el('strong', {}, p.name), ' ', el('span', { class: 'muted' }, `${(ROLES.find((r) => r[0] === p.role) || [0, p.role])[1]}. ${STATUS[p.status] || p.status}.`), ' ',
        p.status !== 'completed' && el('button', { class: 'btn', onclick: async () => {
          try { const r = await api(`/api/firm/discoveries/${id}/participants/${p.participantId}/link`, 'POST'); links.replaceChildren(linkBox(p.name, r.link)); links.scrollIntoView({ block: 'nearest' }); }
          catch (err) { status.textContent = err.message; }
        } }, 'Make a new link')))) : el('p', {}, 'Nobody added yet.'),
      links,
      el('form', { class: 'review add-person', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const who = name.value.trim();
          const r = await api(`/api/firm/discoveries/${id}/participants`, 'POST', { name: who, role: role.value });
          await manage(id);
          document.querySelector('#new-link').replaceChildren(linkBox(who, r.link));
        } catch (err) { status.textContent = err.message; }
      } }, el('h3', {}, 'Add a person'), el('div', { class: 'link-row' }, name, role, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add and get their link'))),
      el('div', { id: 'new-link' }), status),
    participants.some((p) => p.status === 'completed') && el('p', {}, el('a', { class: 'btn', href: `/firm/discoveries/${id}` }, 'See findings')));
}

const d = new URLSearchParams(location.search).get('d');
(d && /^[0-9a-f-]{36}$/.test(d) ? manage(d) : home()).catch((err) => show(el('h1', {}, 'Your discoveries'), el('p', {}, err.message)));
