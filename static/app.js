const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const SUBJ = [['icp','ICP'],['upm','UPM'],['calc','Calculus'],['uhv','UHV'],['em','Eng. Math']];
const fmt = (d, o) => new Date(d + 'T00:00').toLocaleDateString('en-IN', o || {day:'numeric', month:'short', year:'numeric'});
const todayIdx = (new Date().getDay() + 6) % 7;
const todayISO = new Date().toISOString().slice(0, 10);
let U = null, D = null, day = todayIdx, cat = 'All', authMode = 'login';
const staff = () => U && (U.role === 'cr' || U.role === 'admin');

/* ---------- helpers ---------- */
let tt;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2500); }

async function api(method, url, body) {
  const r = await fetch('/api' + url, {
    method, credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'X-Portal': '1'},
    body: body ? JSON.stringify(body) : undefined
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && !['/login', '/register', '/me'].includes(url)) { U = null; showAuth(); throw new Error('Please log in again.'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}
const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message); } };

/* ---------- auth ---------- */
function showAuth() { $('app').hidden = true; $('auth').hidden = false; }
function setMode(m) {
  authMode = m;
  $('t-login').classList.toggle('on', m === 'login'); $('t-reg').classList.toggle('on', m === 'reg');
  $('f-name').hidden = m === 'login'; $('f-name').required = m === 'reg';
  $('f-go').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('f-pw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('f-msg').textContent = '';
}
$('t-login').onclick = () => setMode('login'); $('t-reg').onclick = () => setMode('reg');
$('aform').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await api('POST', authMode === 'login' ? '/login' : '/register', {name: $('f-name').value, email: $('f-email').value, password: $('f-pw').value});
    $('f-pw').value = '';
    if (r.pending) { setMode('login'); $('f-msg').textContent = 'Account created. You can log in once your CR or admin approves you.'; return; }
    await boot();
  } catch (err) { $('f-msg').textContent = err.message; }
};
$('logout').onclick = logout;
async function logout() { try { await api('POST', '/logout'); } catch (e) {} U = D = null; showAuth(); }
$('theme').onclick = toggleTheme;
function toggleTheme() {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
}

/* ---------- routing ---------- */
function views() {
  const v = [['dashboard','📊','Dashboard'], ['announcements','📢','Announcements'], ['events','🎉','Events']];
  if (staff()) v.push(['cr','🛡️','CR Portal']);
  return v;
}
function buildNav() {
  const v = views();
  $('nav').innerHTML = v.map(x => `<li><a href="#${x[0]}" data-v="${x[0]}"><span>${x[1]}</span> ${x[2]}</a></li>`).join('');
  $('bnav').innerHTML = v.map(x => `<a href="#${x[0]}" data-v="${x[0]}"><span>${x[1]}</span>${x[2].split(' ')[0]}</a>`).join('')
    + '<a href="#" id="m-theme"><span>🌓</span>Theme</a><a href="#" id="m-out"><span>🚪</span>Log out</a>';
  $('m-theme').onclick = e => { e.preventDefault(); toggleTheme(); };
  $('m-out').onclick = e => { e.preventDefault(); logout(); };
  $('who').textContent = `${U.name} · ${U.role.toUpperCase()}`;
}
function route() {
  if (!U) return;
  let h = location.hash.slice(1);
  if (!views().some(v => v[0] === h)) h = 'dashboard';
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('on', e.id === h));
  document.querySelectorAll('[data-v]').forEach(a => a.classList.toggle('active', a.dataset.v === h));
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ---------- data ---------- */
async function load() {
  D = await api('GET', '/data');
  renderAll();
  if (staff()) renderCR();
}
async function boot() {
  const {user} = await api('GET', '/me');
  if (!user) return showAuth();
  U = user; $('auth').hidden = true; $('app').hidden = false;
  buildNav(); $('users-card').hidden = U.role !== 'admin';
  try { await load(); } catch (e) { toast(e.message); }
  route();
}

/* ---------- render: shared pages ---------- */
function renderAll() { renderNotice(); renderStats(); renderTT(); renderDays(); renderAtt(); renderAnn(); renderEv(); }

function renderNotice() {
  const p = D.announcements[0];
  $('notice').innerHTML = p ? `<strong>📢 Latest Notice:</strong> ${esc(p.title)}` : 'No notices yet.';
}
function renderStats() {
  const vals = Object.values(D.attendance), tot = vals.reduce((a, x) => a + x.total, 0), at = vals.reduce((a, x) => a + x.att, 0);
  $('stats').innerHTML = [[tot ? Math.round(at / tot * 100) + '%' : '—', 'Overall attendance'], [D.announcements.length, 'Announcements'],
    [D.events.filter(e => e.date >= todayISO).length, 'Upcoming events'], [D.assignments.length, 'Assignments']]
    .map(s => `<div class="stat glass"><b>${s[0]}</b><span class="small">${s[1]}</span></div>`).join('');
}
function renderTT() {
  $('tt-head').innerHTML = '<tr><th>Time</th>' + DAYS.map((d, i) => `<th class="${i === todayIdx ? 'today' : ''}">${d}</th>`).join('') + '</tr>';
  $('tt-body').innerHTML = D.timetable.map(r => `<tr><td><strong>${esc(r[0])}</strong></td>` +
    r[1].map((c, i) => `<td class="${i === todayIdx ? 'today' : ''} ${c === 'Lunch' || c === '—' ? 'brk' : ''}">${esc(c)}</td>`).join('') + '</tr>').join('');
}
function renderDays() {
  $('days').innerHTML = DAYS.map((d, i) => `<button class="${i === day ? 'on' : ''}" data-d="${i}">${d}</button>`).join('');
  const a = D.assignments.filter(x => x.day === day);
  $('assign').innerHTML = a.length ? a.map(x => `<div class="item"><h3>${esc(x.title)}</h3><span class="small">${esc(x.subject)} · due ${fmt(x.due)}</span>${staff() ? `<button class="del" data-delasg="${x.id}" aria-label="Delete assignment">✕</button>` : ''}</div>`).join('')
    : '<p class="empty">No assignments for this day.</p>';
}
$('days').onclick = e => { const b = e.target.closest('button'); if (b) { day = +b.dataset.d; renderDays(); } };
$('assign').onclick = e => { const b = e.target.closest('[data-delasg]'); if (b && confirm('Delete this assignment?')) act(() => api('DELETE', '/assignments/' + b.dataset.delasg), 'Deleted'); };

function renderAtt() {
  $('att').innerHTML = SUBJ.map(([k, n]) => {
    const a = D.attendance[k] || {att: 0, total: 0}, p = a.total ? Math.round(a.att / a.total * 100) : 0;
    let hint = 'No classes logged yet';
    if (a.total) hint = p >= 75 ? `You can safely bunk ${Math.max(0, Math.floor(a.att / .75 - a.total))} more` : `Attend the next ${Math.ceil((.75 * a.total - a.att) / .25)} to reach 75%`;
    const col = p >= 75 ? 'var(--success)' : p >= 60 ? 'var(--warn)' : 'var(--danger)';
    return `<div class="subj"><div><strong>${n}</strong><div class="small">Attended: ${a.att}/${a.total} (${p}%)</div><div class="bar"><div class="fill" style="width:${p}%;background:${col}"></div></div><div class="small" style="margin-top:4px">${hint}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px"><button class="btn att" data-k="${k}" data-y="1">Attend</button><button class="btn bnk" data-k="${k}" data-y="0">Bunk</button></div></div>`;
  }).join('') + '<button class="btn" id="reset" style="margin-top:12px;width:100%">↺ Reset my attendance</button>';
}
$('att').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'reset') { if (confirm('Reset all your attendance counts?')) act(() => api('POST', '/attendance/reset')); return; }
  act(() => api('POST', '/attendance', {subject: b.dataset.k, attended: b.dataset.y === '1'}));
};

function renderAnn() {
  $('acats').innerHTML = ['All', 'Academic', 'Exam', 'General'].map(c => `<button class="${c === cat ? 'on' : ''}" data-c="${c}">${c}</button>`).join('');
  const l = D.announcements.filter(a => cat === 'All' || a.cat === cat);
  $('alist').innerHTML = l.length ? l.map(a => `<div class="card glass" style="margin-bottom:14px">
    ${staff() ? `<button class="del" data-delann="${a.id}" aria-label="Delete announcement">✕</button>` : ''}
    ${a.pinned ? '<span class="pin">📌 PINNED</span> ' : ''}<span class="badge">${esc(a.cat)}</span>
    <h3 style="margin:8px 0 4px">${esc(a.title)}</h3><p>${esc(a.body)}</p><p class="small" style="margin-top:6px">${esc(a.author)} · ${fmt(a.created)}</p></div>`).join('')
    : '<p class="empty">Nothing here yet.</p>';
}
$('acats').onclick = e => { const b = e.target.closest('button'); if (b) { cat = b.dataset.c; renderAnn(); } };
$('alist').onclick = e => { const b = e.target.closest('[data-delann]'); if (b && confirm('Delete this announcement?')) act(() => api('DELETE', '/announcements/' + b.dataset.delann), 'Deleted'); };

function renderEv() {
  $('elist').innerHTML = D.events.length ? D.events.map(e => {
    const d = new Date(e.date + 'T00:00'), on = D.my_rsvps.includes(e.id), past = e.date < todayISO;
    return `<div class="card glass ev">${staff() ? `<button class="del" data-delev="${e.id}" aria-label="Delete event">✕</button>` : ''}
      <div class="date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-IN', {month: 'short'})}</span></div>
      <h3>${esc(e.title)}</h3><p class="small">📍 ${esc(e.place || 'TBA')} · ${fmt(e.date, {weekday: 'long'})}</p>
      <p class="small">👥 ${e.going} going</p>
      ${past ? '<span class="badge">Ended</span>' : `<button class="btn ${on ? 'att' : ''}" data-r="${e.id}" data-on="${on ? 1 : 0}">${on ? '✓ Going (tap to undo)' : 'I’m coming'}</button>`}</div>`;
  }).join('') : '<p class="empty">No events yet.</p>';
}
$('elist').onclick = e => {
  const r = e.target.closest('[data-r]'), d = e.target.closest('[data-delev]');
  if (r) act(() => api('PUT', '/rsvp/' + r.dataset.r, {going: r.dataset.on !== '1'}));
  else if (d && confirm('Delete this event?')) act(() => api('DELETE', '/events/' + d.dataset.delev), 'Deleted');
};

/* ---------- render: CR portal (server still enforces every action) ---------- */
$('s-day').innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
function renderCR() {
  $('tt-edit').innerHTML = '<thead><tr><th>Time</th>' + DAYS.map(d => `<th>${d}</th>`).join('') + '</tr></thead><tbody>' +
    D.timetable.map(r => `<tr><td><input value="${esc(r[0])}" maxlength="12"></td>` + r[1].map(c => `<td><input value="${esc(c)}" maxlength="30"></td>`).join('') + '</tr>').join('') + '</tbody>';
  loadPending();
  if (U.role === 'admin') loadUsers();
}
async function loadUsers() {
  try {
    const {users} = await api('GET', '/users');
    $('users').innerHTML = users.map(u => `<div class="urow"><div><strong>${esc(u.name)}</strong>${u.approved ? '' : ' <span class="badge">pending</span>'}<div class="small">${esc(u.email)}</div></div>
      ${u.id === U.id ? '<span class="badge">You</span>' : `<select data-u="${u.id}" aria-label="Role for ${esc(u.name)}">${['student', 'cr', 'admin'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select><button class="btn" data-rm="${u.id}">Remove</button>`}</div>`).join('');
  } catch (e) { toast(e.message); }
}
async function loadPending() {
  try {
    const {pending} = await api('GET', '/pending');
    $('req').innerHTML = pending.length ? pending.map(u => `<div class="urow"><div><strong>${esc(u.name)}</strong><div class="small">${esc(u.email)}</div></div>
      <div style="display:flex;gap:6px"><button class="btn att" data-ok="${u.id}">Approve</button><button class="btn bnk" data-no="${u.id}">Reject</button></div></div>`).join('')
      : '<p class="empty">No one is waiting.</p>';
  } catch (e) { toast(e.message); }
}
$('req').onclick = e => {
  const a = e.target.closest('[data-ok]'), r = e.target.closest('[data-no]');
  if (a) act(() => api('POST', `/users/${a.dataset.ok}/approve`), 'Approved');
  else if (r && confirm('Reject and delete this request?')) act(() => api('DELETE', `/users/${r.dataset.no}`), 'Removed');
};
$('users').onclick = e => {
  const b = e.target.closest('[data-rm]');
  if (b && confirm('Remove this person? Their attendance and RSVPs are deleted too.')) act(() => api('DELETE', `/users/${b.dataset.rm}`), 'Removed');
};
$('users').onchange = e => { const s = e.target.closest('[data-u]'); if (s) api('PUT', `/users/${s.dataset.u}/role`, {role: s.value}).then(() => toast('Role updated')).catch(x => { toast(x.message); loadUsers(); }); };
$('tt-save').onclick = () => {
  const rows = [...$('tt-edit').querySelectorAll('tbody tr')].map(tr => { const v = [...tr.querySelectorAll('input')].map(i => i.value.trim()); return [v[0], v.slice(1)]; });
  act(() => api('PUT', '/timetable', {rows}), 'Timetable saved');
};
$('a-add').onclick = () => act(async () => {
  await api('POST', '/announcements', {title: $('a-title').value, body: $('a-body').value, cat: $('a-cat').value, pin: $('a-pin').checked});
  $('a-title').value = $('a-body').value = ''; $('a-pin').checked = false;
}, 'Announcement published');
$('e-add').onclick = () => act(async () => {
  await api('POST', '/events', {title: $('e-title').value, date: $('e-date').value, place: $('e-place').value});
  $('e-title').value = $('e-place').value = '';
}, 'Event added');
$('s-add').onclick = () => act(async () => {
  await api('POST', '/assignments', {day: +$('s-day').value, subject: $('s-sub').value, title: $('s-title').value, due: $('s-due').value});
  $('s-title').value = $('s-sub').value = '';
}, 'Assignment added');

boot().catch(() => showAuth());
