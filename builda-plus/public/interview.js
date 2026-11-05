'use strict';
const root = document.getElementById('root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c); // strings become text nodes, never HTML
  return n;
};
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function renderConsent(me) {
  const agree = el('input', { type: 'checkbox', id: 'agree' });
  const start = el('button', { class: 'btn btn-primary', type: 'submit', disabled: '' }, 'Agree and start the interview');
  agree.addEventListener('change', () => { start.disabled = !agree.checked; });
  const error = el('p', { class: 'notice', hidden: '' });
  const form = el('form', { class: 'consent', onsubmit: async (e) => {
    e.preventDefault(); start.disabled = true;
    try { renderInterview(me.firmName, await api('/api/consent', { version: me.consent.version })); }
    catch (err) { error.textContent = err.message; error.hidden = false; start.disabled = false; }
  } },
    el('h1', {}, 'Before you start'),
    el('p', { class: 'muted' }, `Process review for ${me.firmName}`),
    ...me.consent.sections.flatMap((s) => [el('h2', {}, s.heading), el('p', {}, s.body)]),
    el('label', { for: 'agree' }, agree, el('span', {}, 'I’ve read this and I’m happy to take part.')),
    error, start);
  root.replaceChildren(form);
}

function renderInterview(firmName, session) {
  const conversation = el('section', { class: 'conversation', 'aria-label': 'Interview conversation' });
  const journey = el('ol', { class: 'journey', 'aria-label': 'Stages of the mortgage process we’ll cover' });
  const textarea = el('textarea', { id: 'answer', rows: '3', maxlength: '4000', 'aria-label': 'Your answer' });
  const send = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Send');
  const pause = el('button', { class: 'btn', type: 'button' }, 'Pause and save');
  const composer = el('div', { class: 'composer' },
    el('form', { onsubmit: onSend }, textarea, send),
    el('p', { class: 'hint' }, 'Please leave out client names and case details. Rough numbers are fine.'));

  const addMessage = (role, text) => {
    const n = role === 'user'
      ? el('p', { class: 'msg-user' }, text)
      : el('div', { class: 'msg-assistant' }, ...text.split(/\n+/).filter(Boolean).map((para) => el('p', {}, para)));
    conversation.append(n);
    conversation.scrollTop = conversation.scrollHeight; // scroll the conversation, not the page
  };
  const renderStages = (stages) => journey.replaceChildren(...stages.map((s) => el('li', { class: s.state, ...(s.state === 'current' ? { 'aria-current': 'step' } : {}) }, s.name)));
  const closeIfFinished = (s) => {
    if (s.status === 'completed' || s.status === 'escalated') {
      textarea.disabled = true; send.disabled = true; pause.hidden = true;
      composer.replaceChildren(el('p', { class: 'hint' }, s.status === 'completed' ? 'This interview is finished. You can close this page.' : 'This interview is paused while a person from JADA follows up. You can close this page.'));
    }
  };

  async function onSend(e) {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    send.disabled = true; textarea.disabled = true;
    addMessage('user', text);
    const thinking = el('p', { class: 'thinking' }, 'Thinking about your answer…');
    conversation.append(thinking);
    let finished = false;
    try {
      const s = await api('/api/interview/message', { text });
      textarea.value = '';
      thinking.remove(); addMessage('assistant', s.reply); renderStages(s.stages);
      finished = s.status === 'completed' || s.status === 'escalated';
      closeIfFinished(s);
    } catch (err) {
      thinking.remove(); conversation.lastChild.remove();          // keep their text in the box to resend
      conversation.append(el('p', { class: 'notice', role: 'alert' }, err.message));
      conversation.scrollTop = conversation.scrollHeight;
    }
    if (!finished) { send.disabled = false; textarea.disabled = false; textarea.focus(); }
  }
  pause.addEventListener('click', async () => {
    try { await api('/api/interview/pause', {}); composer.replaceChildren(el('p', { class: 'hint' }, 'Saved. Open your interview link again whenever you’re ready to carry on.')); pause.hidden = true; }
    catch (err) { conversation.append(el('p', { class: 'notice', role: 'alert' }, err.message)); }
  });
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.querySelector('form').requestSubmit(); });

  root.replaceChildren(el('div', { class: 'shell' },
    el('header', { class: 'top' }, el('span', { class: 'firm' }, firmName), pause),
    session.stages.length ? journey : el('div'),
    conversation, composer));
  for (const m of session.messages) addMessage(m.role, m.content);
  renderStages(session.stages);
  closeIfFinished(session);
  if (!textarea.disabled) textarea.focus();
}

(async () => {
  try {
    const me = await api('/api/me');
    if (me.consentRequired) renderConsent(me); else renderInterview(me.firmName, me.session);
  } catch (err) {
    root.replaceChildren(el('div', { class: 'consent' }, el('h1', {}, 'We couldn’t open your interview'), el('p', {}, err.message)));
  }
})();
