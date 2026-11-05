'use strict';
// Small signed-in bar for staff pages: who you are, where you can go, and sign out.
(async () => {
  try {
    const res = await fetch('/api/whoami');
    if (!res.ok) return;
    const me = await res.json();
    if (!me.name) return;
    const a = (href, text) => { const x = document.createElement('a'); x.href = href; x.textContent = text; return x; };
    const bar = document.createElement('nav');
    bar.className = 'session-bar';
    bar.setAttribute('aria-label', 'Account');
    const who = document.createElement('span');
    who.textContent = `Signed in as ${me.name}${me.orgName ? `, ${me.orgName}` : ''}`;
    const links = document.createElement('span');
    links.className = 'session-links';
    if (me.kind === 'firm_lead') links.append(a('/firm', 'Your discoveries'));
    if (me.roles && me.roles.includes('engineer')) links.append(a('/jada', 'JADA work'));
    if (me.roles && (me.roles.includes('knowledge_editor') || me.roles.includes('compliance_reviewer'))) links.append(a('/knowledge', 'Knowledge base'));
    links.append(a('/signout', 'Sign out'));
    bar.append(who, links);
    document.body.prepend(bar);
  } catch { /* the page works without the bar */ }
})();
