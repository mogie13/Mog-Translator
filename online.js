// Contribute screen when the app is connected to the contribution server.
// The server checks every permission; the buttons shown here are only hints.
import { api, session, published, fetchAudio, serverBase, serverIsCustom, setServer } from './api.js';

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', reviewer: 'Reviewer', contributor: 'Contributor' };
const STATUS_NAMES = { pending: 'pending', approved: 'approved', rejected: 'rejected', published: 'published' };

/**
 * deps: { view, $, esc, toast, mog, attachMogInput, anyToLatin, categories, onPublished, showLocal,
 *         drawRecorder, getRecording, clearRecording }
 */
export async function drawOnline(d) {
  const { view, $, esc } = d;
  let s = session.get();
  let settings = { allow_unlogged: true, open_signup: true };
  let reachable = true;
  try { settings = await api('/api/settings', { auth: false }); } catch { reachable = false; /* offline: assume defaults */ }
  if (s) { try { const me = await api('/api/me'); s = { ...s, ...me }; session.set(s); } catch (e) { if (e.status === 401) s = null; } }
  const can = (s && s.can) || {};
  const pre = d.prefill;

  view.innerHTML = `<h2>Contribute</h2>
  <div class="row" style="margin-bottom:12px"><span class="note">Sending to the Mog dictionary server.</span>
    <button class="btn small" type="button" id="golocal">Save on this phone instead</button></div>
  <section class="card" id="srv" style="margin-bottom:12px">
    <div class="row" style="justify-content:space-between"><span>Server: <b>${esc(serverBase().replace(/^https?:\/\//, ''))}</b>
      ${reachable ? '<span class="tag ok">connected</span>' : '<span class="tag">can\'t reach it</span>'}</span>
      <button class="btn small" type="button" id="srvchange">Change server</button></div>
    <div id="srvform" ${reachable ? 'hidden' : ''} style="margin-top:10px">
      ${reachable ? '' : '<p class="note" style="margin-top:0">Check you are online. If the server address changed (for example a new tunnel address), enter it here.</p>'}
      <div class="field"><label for="srvurl">Server address</label><input type="url" id="srvurl" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="e.g. something.trycloudflare.com" value="${esc(serverIsCustom() ? serverBase() : '')}"></div>
      <div class="row"><button class="btn primary small" type="button" id="srvsave">Save and connect</button>${serverIsCustom() ? '<button class="btn small" type="button" id="srvreset">Use the built-in address</button>' : ''}</div>
    </div>
  </section>
  <section class="card" id="acct"></section>
  <h3>Suggest a word</h3>
  <form id="oform" class="card" autocomplete="off">
    <div class="field"><label for="okind">What are you adding?</label>
      <select id="okind"><option value="word">A new word</option><option value="phrase">A phrase</option><option value="correction">A correction</option><option value="audio">A pronunciation recording</option></select></div>
    <div class="field"><label for="omog">Mog (any script)</label>
      <input type="text" id="omog" placeholder="e.g. akong, আকোং or Myanmar letters">
      <div class="row"><button class="btn small" id="okb" type="button" aria-pressed="false">Mog keyboard</button></div>
      <div class="preview" id="opv"></div></div>
    <div class="field"><label for="obn">Bengali meaning</label><input type="text" id="obn" lang="bn"></div>
    <div class="field"><label for="oen">English meaning</label><input type="text" id="oen"></div>
    <div class="field"><label for="ocat">Category</label><select id="ocat"><option value="">None</option>${d.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.en)}</option>`).join('')}</select></div>
    <div class="field"><label for="onote">Note (village, usage, what to correct)</label><textarea id="onote" style="min-height:70px"></textarea></div>
    <div class="field"><label>Recording (up to 10 seconds)</label><div class="rec" id="recbox"></div></div>
    <div class="field"><label for="ospk">Speaker name (for credit, can be left blank)</label><input type="text" id="ospk" maxlength="80"></div>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="oconsent"> <span>The speaker agrees that this recording and text can be used in the Mog dictionary and shared with credit.</span></label>
    <fieldset style="border:0;padding:0;margin:0 0 12px;display:grid;gap:10px"><legend style="font-size:14px;font-weight:700;margin-bottom:6px;padding:0">How to send it</legend>
      <label class="check"><input type="radio" name="omode" value="logged"${s ? ' checked' : ' disabled'}>
        <span><b>With my name</b> (logged). It shows in your history with the review result, and reviewers see your name.${s ? '' : ' <span class="note">Sign in above to use this.</span>'}</span></label>
      <label class="check"><input type="radio" name="omode" value="unlogged"${!s && settings.allow_unlogged ? ' checked' : ''}${settings.allow_unlogged ? '' : ' disabled'}>
        <span><b>Anonymously</b> (unlogged). No name or account is stored, so nobody can trace it to you. You can't follow its review or claim credit later. A recording of your own voice can still be recognised.${settings.allow_unlogged ? '' : ' <span class="note">The owner has turned this off.</span>'}</span></label>
    </fieldset>
    <p><button class="btn primary" type="submit">Send suggestion</button></p>
  </form>
  ${s ? '<h3>My suggestions</h3><div id="mine"><p class="note">Loading…</p></div>' : ''}
  ${can.review ? '<h3>Review queue</h3><div id="review"><p class="note">Loading…</p></div>' : ''}
  ${can.edit ? '<h3>Approved, waiting to publish</h3><div id="approved"></div><h3>Published</h3><div id="published"></div>' : ''}
  ${can.manage_users ? '<h3>People and roles</h3><div id="people"></div>' : ''}
  ${can.settings ? '<h3>Settings</h3><div id="settings" class="card"></div>' : ''}
  ${can.audit ? '<h3>Audit log</h3><p class="note">Every role change, review, edit and setting change. It can\'t be edited or deleted.</p><div id="audit"></div>' : ''}`;

  $('#golocal').onclick = d.showLocal;
  $('#srvchange').onclick = () => { $('#srvform').hidden = !$('#srvform').hidden; if (!$('#srvform').hidden) $('#srvurl').focus(); };
  const useServer = (v) => {
    try {
      const now = setServer(v);
      d.toast('Server: ' + now.replace(/^https?:\/\//, ''));
      if (d.onPublished) d.onPublished();
      drawOnline({ ...d, prefill: null });
    } catch (e) { d.toast(e.message); }
  };
  $('#srvsave').onclick = () => useServer($('#srvurl').value);
  if ($('#srvreset')) $('#srvreset').onclick = () => useServer('');
  if (pre) {
    if (pre.kind) $('#okind').value = pre.kind;
    if (pre.target) $('#oform').dataset.target = pre.target;
    if (pre.mog) $('#omog').value = pre.mog;
    if (pre.en) $('#oen').value = pre.en;
    if (pre.bn) $('#obn').value = pre.bn;
    if (pre.category) $('#ocat').value = pre.category;
    if (pre.kind === 'correction' && pre.en) $('#onote').value = `Correction for "${pre.en}": `;
  }
  d.attachMogInput($('#omog'), $('#opv'), $('#okb'));
  d.drawRecorder();
  drawAccount(d, s, settings);

  $('#oform').onsubmit = async (ev) => {
    ev.preventDefault();
    const typed = $('#omog').value.trim();
    if (!typed) { d.toast('Add the Mog word or phrase first'); return; }
    const mode = (view.querySelector('input[name=omode]:checked') || {}).value;
    if (!mode) { d.toast('Choose how to send it'); return; }
    const kind = $('#okind').value; const rec = d.getRecording();
    if (kind === 'audio' && !rec) { d.toast('Record the pronunciation first'); return; }
    if (rec && !$('#oconsent').checked) { d.toast('Please confirm the speaker agrees'); return; }
    const body = {
      mode, kind, mog: d.anyToLatin(typed)[0] || typed,
      bengali: $('#obn').value.trim(), english: $('#oen').value.trim(), category: $('#ocat').value, note: $('#onote').value.trim(),
      speaker: $('#ospk').value.trim(), target: $('#oform').dataset.target || '', consent: $('#oconsent').checked,
    };
    if (rec) body.audio = { type: rec.type, data: await toBase64(rec) };
    const btn = ev.submitter || $('#oform button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/contributions', { method: 'POST', body, auth: mode === 'logged' });
      d.clearRecording();
      d.toast(mode === 'logged' ? 'Sent. You can follow it under My suggestions.' : 'Sent anonymously. Thank you.');
      drawOnline({ ...d, prefill: null });
    } catch (e) { d.toast(e.message); btn.disabled = false; }
  };

  const jobs = [];
  if (s) jobs.push(drawMine(d));
  if (can.review) jobs.push(drawQueue(d, 'pending', '#review', s));
  if (can.edit) jobs.push(drawQueue(d, 'approved', '#approved', s), drawQueue(d, 'published', '#published', s));
  if (can.manage_users) jobs.push(drawPeople(d, s));
  if (can.settings) drawSettings(d, settings);
  if (can.audit) jobs.push(drawAudit(d));
  await Promise.allSettled(jobs);
}

function drawAccount(d, s, settings) {
  const { $, esc } = d;
  const box = $('#acct');
  if (s && s.user) {
    box.innerHTML = `<div class="row" style="justify-content:space-between"><span>Signed in as <b>${esc(s.user.name)}</b> <span class="tag ok">${esc(ROLE_NAMES[s.user.role])}</span></span>
      <button class="btn small" type="button" id="signout">Sign out</button></div>`;
    $('#signout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch { /* already gone */ } session.clear(); drawOnline(d); };
    return;
  }
  box.innerHTML = `<p style="margin-top:0">Sign in to get credit and follow your suggestions. You can also send anonymously without an account.</p>
    <div class="field"><label for="aname">Name</label><input type="text" id="aname" autocomplete="username"></div>
    <div class="field"><label for="apw">Password</label><input type="password" id="apw" autocomplete="current-password"></div>
    <div class="row"><button class="btn primary" type="button" id="signin">Sign in</button>${settings.open_signup ? '<button class="btn" type="button" id="signup">Create account</button>' : '<span class="note">New accounts are closed. Ask an admin.</span>'}</div>`;
  const go = (path) => async () => {
    try {
      const out = await api(path, { method: 'POST', body: { name: $('#aname').value.trim(), password: $('#apw').value }, auth: false });
      session.set(out); d.toast(`Welcome, ${out.user.name}`); drawOnline(d);
    } catch (e) { d.toast(e.message); }
  };
  $('#signin').onclick = go('/api/login');
  if ($('#signup')) $('#signup').onclick = go('/api/signup');
}

const KIND_NAMES = { word: 'word', phrase: 'phrase', correction: 'correction', audio: 'recording' };
const gloss = (d, c) => `${d.esc(KIND_NAMES[c.kind] || c.kind)}${c.english ? ' · ' + d.esc(c.english) : ''}${c.bengali ? ' · ' + d.esc(c.bengali) : ''}${c.has_audio && c.kind !== 'audio' ? ' · with recording' : ''}${c.speaker ? ' · speaker ' + d.esc(c.speaker) : ''}${c.note ? ' · ' + d.esc(c.note) : ''}`;
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
const listenBtn = (c) => (c.has_audio ? `<button class="btn small" type="button" data-listen="${c.id}">▶ Listen</button>` : '');
// Recordings that aren't published yet need the login, so they are fetched, not linked.
function wireListen(d, box) {
  box.querySelectorAll('[data-listen]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const url = URL.createObjectURL(await fetchAudio(b.dataset.listen));
      const a = document.createElement('audio'); a.controls = true; a.src = url;
      a.style.cssText = 'display:block;width:100%;margin-top:8px';
      // On its own line under the word, so the player doesn't cover the text.
      const item = b.closest('.item');
      if (item) { item.after(a); b.remove(); } else b.replaceWith(a);
      a.play().catch(() => {});
    } catch (e) { d.toast(e.message); b.disabled = false; }
  }));
}
const statusTag = (d, st) => `<span class="status ${d.esc(st)}">${d.esc(STATUS_NAMES[st] || st)}</span>`;

async function drawMine(d) {
  const box = d.$('#mine');
  try {
    const { items } = await api('/api/contributions/mine');
    box.innerHTML = items.length ? '<ul class="list">' + items.map((c) => `<li><div class="item"><span><span class="mogw">${d.esc(d.mog(c.mog))}</span><br><span class="gloss">${gloss(d, c)}</span>
      ${c.status === 'rejected' && c.reject_reason ? `<br><span class="note">Reason: ${d.esc(c.reject_reason)}</span>` : ''}</span><span class="row" style="justify-content:flex-end">${listenBtn(c)}${statusTag(d, c.status)}</span></div></li>`).join('') + '</ul>'
      : '<p class="empty">Nothing sent with your name yet. Anonymous suggestions aren\'t listed here.</p>';
    wireListen(d, box);
  } catch (e) { box.innerHTML = `<p class="note">${d.esc(e.message)}</p>`; }
}

async function drawQueue(d, status, sel, s) {
  const box = d.$(sel); const { esc } = d;
  try {
    const { items } = await api('/api/contributions?status=' + status);
    if (!items.length) { box.innerHTML = `<p class="empty">${status === 'pending' ? 'Nothing waiting for review.' : 'Nothing here.'}</p>`; return; }
    const mineId = s && s.user ? s.user.name : null;
    box.innerHTML = (status === 'pending' ? '<p class="note">Approve only what a second speaker has confirmed.</p>' : '') + '<ul class="list">' + items.map((c) => `<li data-id="${c.id}"><div class="item"><span><span class="mogw">${esc(d.mog(c.mog))}</span><br><span class="gloss">${gloss(d, c)}</span><br>
      <span class="note">${c.mode === 'logged' ? 'From ' + esc(c.submitted_by_name || '?') : 'Anonymous'}${c.reviewed_by_name ? ' · reviewed by ' + esc(c.reviewed_by_name) : ''}</span></span>
      <span class="row" style="justify-content:flex-end">${listenBtn(c)}${
        status === 'pending' ? (c.submitted_by_name && c.submitted_by_name === mineId ? '<span class="note">Your own: someone else reviews it</span>'
          : '<button class="btn small" data-act="approve">Approve</button><button class="btn small" data-act="reject">Reject</button>')
        : status === 'approved' ? '<button class="btn small" data-act="publish">Publish</button><button class="btn small" data-act="edit">Edit</button>'
          : '<button class="btn small" data-act="unpublish">Unpublish</button><button class="btn small" data-act="edit">Edit</button>'}</span></div>
      <div class="more" hidden></div></li>`).join('') + '</ul>';
    box.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(d, b, items, s)));
    wireListen(d, box);
  } catch (e) { box.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

async function act(d, b, items, s) {
  const li = b.closest('li'); const id = li.dataset.id; const c = items.find((x) => String(x.id) === id);
  const more = li.querySelector('.more'); const { esc } = d;
  const run = async (path, body, msg) => {
    try { await api(`/api/contributions/${id}/${path}`, { method: 'POST', body }); d.toast(msg); d.onPublished(); drawOnline({ ...d, prefill: null }); } catch (e) { d.toast(e.message); }
  };
  if (b.dataset.act === 'approve') return run('approve', undefined, 'Approved. An admin can now publish it.');
  if (b.dataset.act === 'publish') return run('publish', undefined, 'Published to the dictionary');
  if (b.dataset.act === 'unpublish') { if (confirm('Take this out of the dictionary?')) run('unpublish', undefined, 'Unpublished'); return; }
  if (b.dataset.act === 'reject') {
    more.hidden = false;
    more.innerHTML = `<div class="field"><label>Reason (the contributor sees this)</label><input type="text" class="reason" maxlength="500"></div>
      <p><button class="btn small primary" type="button">Reject with this reason</button></p>`;
    more.querySelector('.reason').focus();
    more.querySelector('button').onclick = () => {
      const reason = more.querySelector('.reason').value.trim();
      if (!reason) { d.toast('Give a reason'); return; }
      run('reject', { reason }, 'Rejected');
    };
    return;
  }
  if (b.dataset.act === 'edit') {
    more.hidden = false;
    const f = (k, label) => `<div class="field"><label>${label}</label><input type="text" data-k="${k}" value="${esc(c[k] || '')}"></div>`;
    more.innerHTML = f('mog', 'Mog (Latin)') + f('bengali', 'Bengali') + f('english', 'English') + f('speaker', 'Speaker') + f('note', 'Note')
      + (c.has_audio ? '<label class="check" style="margin-bottom:10px"><input type="checkbox" class="rmaudio"> <span>Remove the recording</span></label>' : '')
      + '<p><button class="btn small primary" type="button">Save changes</button></p>';
    more.querySelector('button.primary').onclick = () => {
      const body = {}; more.querySelectorAll('[data-k]').forEach((i) => (body[i.dataset.k] = i.value.trim()));
      if (more.querySelector('.rmaudio') && more.querySelector('.rmaudio').checked) body.remove_audio = true;
      if (body.mog) body.mog = d.anyToLatin(body.mog)[0] || body.mog;
      run('edit', body, 'Saved. The change is in the audit log.');
    };
  }
}

async function drawPeople(d, s) {
  const box = d.$('#people'); const { esc } = d;
  try {
    const { users, assign_roles: roles } = await api('/api/users');
    box.innerHTML = '<ul class="list">' + users.map((u) => `<li data-id="${u.id}"><div class="item"><span><b>${esc(u.name)}</b>${u.active ? '' : ' <span class="tag">removed</span>'}<br>
      <span class="note">${esc(ROLE_NAMES[u.role])}${u.id === s.user.id ? ' · you' : ''}</span></span>
      <span class="row" style="justify-content:flex-end">${u.can_change ? `<select data-act="role" aria-label="Role for ${esc(u.name)}">${roles.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}${roles.includes(u.role) ? '' : `<option value="${u.role}" selected disabled>${ROLE_NAMES[u.role]}</option>`}</select>
        ${u.active ? '<button class="btn small" data-act="remove">Remove</button>' : '<button class="btn small" data-act="restore">Restore</button>'}` : ''}
        ${s.can.transfer && u.id !== s.user.id && u.active ? '<button class="btn small" data-act="transfer">Make owner</button>' : ''}</span></div><div class="more" hidden></div></li>`).join('') + '</ul>'
      + `<p class="note">${s.user.role === 'owner' ? 'You can change anyone except yourself.' : 'Admins can change reviewers and contributors only.'} The server checks every change.</p>`;
    box.querySelectorAll('[data-act]').forEach((el) => {
      const li = el.closest('li'); const id = li.dataset.id; const u = users.find((x) => String(x.id) === id);
      const done = async (path, body, msg) => { try { await api(`/api/users/${id}/${path}`, { method: 'POST', body }); d.toast(msg); drawOnline({ ...d, prefill: null }); } catch (e) { d.toast(e.message); drawPeople(d, s); } };
      if (el.dataset.act === 'role') el.onchange = () => done('role', { role: el.value }, `${u.name} is now ${ROLE_NAMES[el.value]}`);
      if (el.dataset.act === 'remove') el.onclick = () => { if (confirm(`Remove ${u.name}? They are signed out and can't sign in.`)) done('remove', undefined, 'Removed'); };
      if (el.dataset.act === 'restore') el.onclick = () => done('restore', undefined, 'Restored');
      if (el.dataset.act === 'transfer') el.onclick = () => {
        const more = li.querySelector('.more'); more.hidden = false;
        more.innerHTML = `<p class="note">${esc(u.name)} becomes the owner and you become an admin. Only they can undo this.</p>
          <div class="field"><label>Your password, to confirm</label><input type="password" class="pw" autocomplete="current-password"></div>
          <p><button class="btn small primary" type="button">Transfer ownership</button></p>`;
        more.querySelector('button').onclick = async () => {
          try { await api('/api/transfer-ownership', { method: 'POST', body: { user_id: u.id, password: more.querySelector('.pw').value } }); d.toast(`${u.name} is now the owner`); drawOnline({ ...d, prefill: null }); } catch (e) { d.toast(e.message); }
        };
      };
    });
  } catch (e) { box.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

function drawSettings(d, settings) {
  const box = d.$('#settings');
  box.innerHTML = `<label class="check"><input type="checkbox" id="s_unlogged"${settings.allow_unlogged ? ' checked' : ''}> <span>Allow anonymous (unlogged) suggestions. Anonymous abuse can't be traced to a person; the server only limits how many arrive from one place per hour.</span></label>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="s_signup"${settings.open_signup ? ' checked' : ''}> <span>Anyone can create a contributor account</span></label>`;
  const save = async () => {
    try { await api('/api/settings', { method: 'POST', body: { allow_unlogged: d.$('#s_unlogged').checked, open_signup: d.$('#s_signup').checked } }); d.toast('Settings saved'); } catch (e) { d.toast(e.message); }
  };
  d.$('#s_unlogged').onchange = save; d.$('#s_signup').onchange = save;
}

async function drawAudit(d) {
  const box = d.$('#audit'); const { esc } = d;
  const words = { approve: 'approved', reject: 'rejected', publish: 'published', unpublish: 'unpublished', edit: 'edited',
    role_change: 'changed role of', remove_user: 'removed', restore_user: 'restored', transfer_ownership: 'transferred ownership to', settings: 'changed settings' };
  const what = (a) => {
    const det = a.details || {};
    if (a.target.startsWith('user:')) return `${esc(det.name || det.to || a.target)}${det.from && det.to && a.action === 'role_change' ? ` (${esc(ROLE_NAMES[det.from])} → ${esc(ROLE_NAMES[det.to])})` : ''}`;
    if (a.target.startsWith('contribution:')) return `suggestion #${esc(a.target.split(':')[1])}${det.reason ? ` (“${esc(det.reason)}”)` : ''}${a.action === 'edit' ? ` (${esc(Object.keys(det).join(', '))})` : ''}`;
    return esc(Object.entries(det).map(([k, v]) => `${k}: ${v.to ? 'on' : 'off'}`).join(', '));
  };
  try {
    const { items } = await api('/api/audit');
    box.innerHTML = items.length ? '<ul class="list">' + items.map((a) => `<li><div class="item"><span><b>${esc(a.actor_name)}</b> ${esc(words[a.action] || a.action)} ${what(a)}</span>
      <span class="pos">${esc(new Date(a.created_at).toLocaleString())}</span></div></li>`).join('') + '</ul>' : '<p class="empty">No admin actions yet.</p>';
  } catch (e) { box.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

export { published };
