'use strict';
const root = document.getElementById('root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.issues ? 'Please fill in both fields.' : (data.error || 'Something went wrong.'));
  return data;
}
const ROLE = { engineer: 'engineer', knowledge_editor: 'knowledge editor', compliance_reviewer: 'compliance reviewer' };
const status = el('p', { class: 'status', role: 'status' });
const signIn = (userId) => async () => { try { location.href = (await api('/api/signin', 'POST', { userId })).next; } catch (err) { status.textContent = err.message; } };

(async () => {
  let accounts = [];
  try { accounts = (await api('/api/signin/directory')).accounts; }
  catch { root.replaceChildren(el('h1', {}, 'Sign-in isn’t available'), el('p', {}, 'Push-button sign-in only works in demo mode.')); return; }
  const firms = accounts.filter((a) => a.kind === 'firm_lead');
  const team = accounts.filter((a) => a.kind === 'jada');
  const firmName = el('input', { name: 'firmName', placeholder: 'Firm name', autocomplete: 'organization' });
  const yourName = el('input', { name: 'yourName', placeholder: 'Your name', autocomplete: 'name' });

  root.replaceChildren(
    el('h1', {}, 'builda+'),
    el('p', { class: 'muted' }, 'Choose who you are. There are no passwords in this demo, so don’t put real firm or client information in it.'),
    el('section', {},
      el('h2', {}, 'Mortgage firms'),
      firms.length ? el('div', { class: 'accounts' }, ...firms.map((f) => el('button', { class: 'account', onclick: signIn(f.userId) },
        el('strong', {}, f.orgName || 'Firm'), el('span', {}, f.name)))) : el('p', { class: 'muted' }, 'No firms yet.'),
      el('form', { class: 'new-firm', onsubmit: async (e) => {
        e.preventDefault();
        try { location.href = (await api('/api/signin/new-firm', 'POST', { firmName: firmName.value, yourName: yourName.value })).next; } catch (err) { status.textContent = err.message; }
      } }, el('h3', {}, 'Set up a new firm'), firmName, yourName, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create firm and sign in'))),
    el('section', {},
      el('h2', {}, 'JADA team'),
      team.length ? el('div', { class: 'accounts' }, ...team.map((t) => el('button', { class: 'account', onclick: signIn(t.userId) },
        el('strong', {}, t.name), el('span', {}, t.roles.map((r) => ROLE[r] || r).join(', ') || 'no role yet')))) :
        el('p', { class: 'muted' }, 'No JADA team members yet. Run “npm run setup-demo” once to create them.')),
    status,
    el('p', { class: 'muted small' }, 'People taking part in an interview don’t sign in here — they use the link their firm lead gives them.'));
})();
