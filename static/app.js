const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const SUBJ = [['icp','ICP'],['upm','UPM'],['calc','Calculus'],['uhv','UHV'],['em','Eng. Math']];
const ICON = {announcement:'📢', event:'🎉', assignment:'📄', exam:'📝', timetable:'📅'};
const todayISO = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const todayIdx = (new Date().getDay() + 6) % 7;
const fmt = (d, o) => new Date(d + 'T00:00').toLocaleDateString('en-IN', o || {day:'numeric', month:'short', year:'numeric'});
const dd = d => Math.round((new Date(d + 'T00:00') - new Date(todayISO + 'T00:00')) / 864e5);
const ago = ts => { const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
const dueTag = n => n < 0 ? `<span class="tag red">Overdue ${-n}d</span>` : n === 0 ? '<span class="tag red">Due today</span>'
  : n === 1 ? '<span class="tag amber">Tomorrow</span>' : n <= 3 ? `<span class="tag amber">${n} days left</span>` : `<span class="tag">${n} days left</span>`;
let U = null, D = null, cat = 'All', dtab = 'asg', authMode = 'login', lastNid = 0, ttDirty = false;
const edit = {};
const staff = () => U && (U.role === 'cr' || U.role === 'admin');

/* ---------- CR forms (one config drives form, edit and API path) ---------- */
const F = {
  ann:  {t:'announcement', path:'/announcements', list:() => D.announcements, f:[['title','input','Title',80],['cat','select',['Academic','Exam','General']],['body','textarea','Details',400],['pin','check','Pin as latest notice']]},
  exam: {t:'exam / mid-sem entry', path:'/exams', list:() => D.exams, f:[['title','input','Exam (e.g. Mid-sem)',40],['subject','input','Subject',30],['date','date','Date'],['time','input','Time (e.g. 10:00 AM)',20],['venue','input','Venue',40]]},
  event:{t:'event', path:'/events', list:() => D.events, f:[['title','input','Event name',60],['date','date','Date'],['place','input','Venue',60]]},
  asg:  {t:'assignment', path:'/assignments', list:() => D.assignments, f:[['subject','input','Subject',30],['title','input','Assignment title',80],['due','date','Deadline']]},
  link: {t:'link', path:'/links', list:() => D.links, f:[['kind','select',[['resource','Resource (shows on Dashboard)'],['social','Social group (Social page)']]],['title','input','Title',60],['url','input','https://…',300],['note','input','Short note (optional)',80]]}
};
const fid = (k, n) => `f-${k}-${n}`;
function buildForms() {
  for (const [k, f] of Object.entries(F)) {
    const fields = f.f.map(([n, t, a, b]) => {
      const id = fid(k, n);
      if (t === 'select') return `<select id="${id}" aria-label="${n}">${a.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${v}">${l}</option>`; }).join('')}</select>`;
      if (t === 'textarea') return `<textarea id="${id}" placeholder="${a}" maxlength="${b}"></textarea>`;
      if (t === 'date') return `<label class="small">${a}<input id="${id}" type="date"></label>`;
      if (t === 'check') return `<label class="small"><input id="${id}" type="checkbox" style="width:auto;margin-right:6px">${a}</label>`;
      return `<input id="${id}" placeholder="${a}" maxlength="${b}">`;
    }).join('');
    $('fm-' + k).innerHTML = `<div class="card glass"><h2 id="h-${k}">New ${f.t}</h2><div class="form">${fields}
      <div class="row"><button class="btn" id="go-${k}">Publish</button><button class="btn" id="no-${k}" hidden>Cancel edit</button></div></div></div>`;
    $('go-' + k).onclick = () => submitForm(k);
    $('no-' + k).onclick = () => resetForm(k);
  }
}
const vals = k => Object.fromEntries(F[k].f.map(([n, t]) => [n, t === 'check' ? $(fid(k, n)).checked : $(fid(k, n)).value]));
function resetForm(k) {
  F[k].f.forEach(([n, t]) => { const e = $(fid(k, n)); if (t === 'check') e.checked = false; else if (t === 'select') e.selectedIndex = 0; else e.value = ''; });
  edit[k] = null; $('h-' + k).textContent = 'New ' + F[k].t; $('go-' + k).textContent = 'Publish'; $('no-' + k).hidden = true;
}
function submitForm(k) {
  const id = edit[k], was = !!id;
  act(async () => { await api(id ? 'PUT' : 'POST', F[k].path + (id ? '/' + id : ''), vals(k)); resetForm(k); }, was ? 'Updated' : 'Published');
}
function startEdit(k, id) {
  const it = F[k].list().find(x => x.id == id); if (!it) return;
  F[k].f.forEach(([n, t]) => { const e = $(fid(k, n)), v = n === 'pin' ? it.pinned : it[n]; if (t === 'check') e.checked = !!v; else e.value = v ?? ''; });
  edit[k] = +id; $('h-' + k).textContent = 'Edit ' + F[k].t; $('go-' + k).textContent = 'Save changes'; $('no-' + k).hidden = false;
  location.hash = 'cr'; setTimeout(() => $('fm-' + k).scrollIntoView({behavior: 'smooth', block: 'center'}), 60);
}
const acts = (k, id) => staff() ? `<span class="acts"><button class="ed" data-ed="${k}:${id}" aria-label="Edit">✎</button><button class="ed" data-rm="${k}:${id}" aria-label="Delete">✕</button></span>` : '';
document.addEventListener('click', e => {
  const ed = e.target.closest('[data-ed]'), rm = e.target.closest('[data-rm]'), tr = e.target.closest('[data-tr]');
  if (ed) { const [k, id] = ed.dataset.ed.split(':'); startEdit(k, id); }
  else if (rm) { const [k, id] = rm.dataset.rm.split(':'); if (confirm('Delete this ' + F[k].t + '?')) act(() => api('DELETE', F[k].path + '/' + id), 'Deleted'); }
  else if (tr) { readTT(); ttDraft.splice(+tr.dataset.tr, 1); ttDirty = true; drawTT(); }
  if (!e.target.closest('#npanel,#bell')) $('npanel').hidden = true;
});

/* ---------- helpers ---------- */
let tmr;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tmr); tmr = setTimeout(() => t.classList.remove('on'), 2500); }
async function api(method, url, body) {
  const r = await fetch('/api' + url, {method, credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Portal': '1'}, body: body ? JSON.stringify(body) : undefined});
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && !['/login', '/register', '/me'].includes(url)) { U = null; showAuth(); throw new Error('Please log in again.'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}
const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message); } };

/* ---------- auth ---------- */
function showAuth() { $('app').hidden = true; $('auth').hidden = false; }
function setMode(m) {
  authMode = m; $('t-login').classList.toggle('on', m === 'login'); $('t-reg').classList.toggle('on', m === 'reg');
  $('f-name').hidden = m === 'login'; $('f-name').required = m === 'reg';
  $('f-go').textContent = m === 'login' ? 'Log in' : 'Create account'; $('f-msg').textContent = '';
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
async function logout() { try { await api('POST', '/logout'); } catch (e) {} U = D = null; showAuth(); }
function toggleTheme() { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; }
$('logout').onclick = $('m-out').onclick = logout;
$('theme').onclick = $('m-theme').onclick = toggleTheme;

/* ---------- routing ---------- */
function views() {
  const v = [['dashboard','📊','Dashboard'], ['announcements','📢','Notices'], ['events','🎉','Events'], ['social','💬','Social']];
  if (staff()) v.push(['cr','🛡️','CR Portal']);
  return v;
}
function buildNav() {
  const v = views();
  $('nav').innerHTML = v.map(x => `<li><a href="#${x[0]}" data-v="${x[0]}"><span>${x[1]}</span> ${x[2]}</a></li>`).join('');
  $('bnav').innerHTML = v.map(x => `<a href="#${x[0]}" data-v="${x[0]}"><span>${x[1]}</span>${x[2].split(' ')[0]}</a>`).join('');
  $('who').textContent = `${U.name} · ${U.role.toUpperCase()}`;
}
function route() {
  if (!U) return;
  let h = location.hash.slice(1); if (!views().some(v => v[0] === h)) h = 'dashboard';
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('on', e.id === h));
  document.querySelectorAll('[data-v]').forEach(a => a.classList.toggle('active', a.dataset.v === h));
  $('npanel').hidden = true; window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ---------- data ---------- */
async function load() { D = await api('GET', '/data'); lastNid = D.notifications[0]?.id || 0; renderAll(); if (staff()) renderCR(); }
async function boot() {
  const {user} = await api('GET', '/me'); if (!user) return showAuth();
  U = user; $('auth').hidden = true; $('app').hidden = false; buildNav(); $('users-card').hidden = U.role !== 'admin';
  try { await load(); } catch (e) { toast(e.message); }
  route();
}
setInterval(async () => {  // checks for new updates every minute while the page is open
  if (!U) return;
  try {
    const n = await api('GET', '/notifications'), top = n.notifications[0]?.id || 0;
    if (top > lastNid) {
      if ('Notification' in window && Notification.permission === 'granted') n.notifications.filter(x => x.id > lastNid).slice(0, 3).forEach(x => new Notification('Section Portal', {body: x.title}));
      await load();
    }
  } catch (e) {}
}, 60000);

/* ---------- bell ---------- */
$('bell').onclick = () => {
  const p = $('npanel'); p.hidden = !p.hidden;
  if (!p.hidden && D.unread) api('POST', '/notifications/seen').then(() => { D.unread = 0; $('badge').hidden = true; }).catch(() => {});
};
$('nperm').onclick = () => Notification.requestPermission().then(renderBell);
function renderBell() {
  $('badge').hidden = !D.unread; $('badge').textContent = D.unread > 9 ? '9+' : D.unread;
  $('nlist').innerHTML = D.notifications.length ? D.notifications.map((n, i) => `<div class="item ${i < D.unread ? 'new' : ''}">${ICON[n.kind] || '🔔'} ${esc(n.title)}<div class="small">${ago(n.created)}</div></div>`).join('') : '<p class="empty">No notifications yet.</p>';
  $('nperm').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

/* ---------- dashboard ---------- */
function attStats() {
  const v = SUBJ.map(([k, n]) => { const a = D.attendance[k] || {att: 0, total: 0}; return {k, n, att: a.att, total: a.total, p: a.total ? Math.round(a.att / a.total * 100) : 0}; });
  const at = v.reduce((s, x) => s + x.att, 0), tot = v.reduce((s, x) => s + x.total, 0);
  return {v, at, tot, p: tot ? Math.round(at / tot * 100) : 0};
}
const col = p => p >= 75 ? 'var(--success)' : p >= 60 ? 'var(--warn)' : 'var(--danger)';
const upcoming = () => D.assignments.filter(a => dd(a.due) >= 0).sort((a, b) => a.due.localeCompare(b.due));

function renderAll() { renderBell(); renderNotice(); renderStats(); renderTT(); renderDL(); renderRes(); renderAtt(); renderIns(); renderAnn(); renderEv(); renderSocial(); }

function renderNotice() { const p = D.announcements[0]; $('notice').innerHTML = p ? `<strong>📢 ${esc(p.title)}</strong>` : 'No notices yet.'; }
function renderStats() {
  const s = attStats(), up = upcoming();
  $('stats').innerHTML = [[s.tot ? s.p + '%' : '—', 'Overall attendance'], [up.length ? (dd(up[0].due) === 0 ? 'Today' : dd(up[0].due) + 'd') : '—', 'Next deadline'],
    [D.events.filter(e => e.date >= todayISO).length, 'Upcoming events'], [up.length, 'Pending assignments']].map(x => `<div class="stat glass"><b>${x[0]}</b><span class="small">${x[1]}</span></div>`).join('');
}
function renderTT() {
  $('tt-head').innerHTML = '<tr><th>Time</th>' + DAYS.map((d, i) => `<th class="${i === todayIdx ? 'today' : ''}">${d}</th>`).join('') + '</tr>';
  $('tt-body').innerHTML = D.timetable.map(r => `<tr><td><strong>${esc(r[0])}</strong></td>` + r[1].map((c, i) => `<td class="${i === todayIdx ? 'today' : ''} ${c === 'Lunch' || c === '—' ? 'brk' : ''}">${esc(c)}</td>`).join('') + '</tr>').join('');
}
function renderDL() {
  $('dtabs').innerHTML = [['asg', 'Assignments'], ['exam', 'Exams']].map(([k, n]) => `<button class="${k === dtab ? 'on' : ''}" data-t="${k}">${n}</button>`).join('');
  const row = (k, x, title, sub, date) => `<div class="item">${acts(k, x.id)}<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h3>${esc(title)}</h3><span class="small">${sub}</span></div>${dueTag(dd(date))}</div></div>`;
  let up, past, mk;
  if (dtab === 'asg') { mk = a => row('asg', a, a.title, `${esc(a.subject)} · due ${fmt(a.due)}`, a.due); up = upcoming(); past = D.assignments.filter(a => dd(a.due) < 0).sort((a, b) => b.due.localeCompare(a.due)); }
  else { mk = e => row('exam', e, `${e.title}${e.subject ? ' · ' + e.subject : ''}`, `${fmt(e.date, {weekday: 'short', day: 'numeric', month: 'short'})}${e.time ? ' · ' + esc(e.time) : ''}${e.venue ? ' · 📍' + esc(e.venue) : ''}`, e.date);
    up = D.exams.filter(e => dd(e.date) >= 0); past = D.exams.filter(e => dd(e.date) < 0).reverse(); }
  $('dlist').innerHTML = (up.length ? up.map(mk).join('') : `<p class="empty">Nothing upcoming.</p>`) + (past.length ? `<details><summary>Past (${past.length})</summary>${past.map(mk).join('')}</details>` : '');
}
$('dtabs').onclick = e => { const b = e.target.closest('button'); if (b) { dtab = b.dataset.t; renderDL(); } };
function renderRes() {
  const l = D.links.filter(x => x.kind === 'resource');
  $('res').innerHTML = l.length ? l.map(x => `<div class="item">${acts('link', x.id)}<div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div><h3>${esc(x.title)}</h3><span class="small">${esc(x.note)}</span></div><a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open</a></div></div>`).join('') : '<p class="empty">No resources yet. Your CR can add a Drive link.</p>';
}

/* attendance */
function renderAtt() {
  const s = attStats();
  $('att').innerHTML = s.v.map(a => {
    let hint = 'No classes logged yet';
    if (a.total) hint = a.p >= 75 ? `You can safely bunk ${Math.max(0, Math.floor(a.att / .75 - a.total))} more` : `Attend the next ${Math.ceil((.75 * a.total - a.att) / .25)} to reach 75%`;
    const has = D.att_log.some(x => x.subject === a.k);
    return `<div class="subj"><div><strong>${a.n}</strong><div class="small">Attended: ${a.att}/${a.total} (${a.p}%)</div><div class="bar"><div class="fill" style="width:${a.p}%;background:${col(a.p)}"></div></div><div class="small" style="margin-top:4px">${hint}</div></div>
      <div><button class="btn att" data-k="${a.k}" data-y="1">Attend</button><button class="btn bnk" data-k="${a.k}" data-y="0">Bunk</button><button class="btn sm" data-undo="${a.k}" ${has ? '' : 'disabled'}>↶ Undo last</button></div></div>`;
  }).join('') + '<button class="btn" id="reset" style="margin-top:12px;width:100%">↺ Reset my attendance</button>';
}
$('att').onclick = e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.id === 'reset') { if (confirm('Reset all your attendance counts?')) act(() => api('POST', '/attendance/reset')); return; }
  if (b.dataset.undo) return act(() => api('POST', '/attendance/undo', {subject: b.dataset.undo}), 'Undone');
  act(() => api('POST', '/attendance', {subject: b.dataset.k, attended: b.dataset.y === '1'}));
};
function renderIns() {
  const s = attStats();
  if (!s.tot) { $('ins').innerHTML = '<p class="empty">Mark a few classes to see your charts.</p>'; return; }
  const R = 42, C = 2 * Math.PI * R, L = D.att_log;
  const donut = `<svg viewBox="0 0 100 100" width="120" height="120" role="img" aria-label="Overall attendance ${s.p}%"><circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--line)" stroke-width="10"/><circle cx="50" cy="50" r="${R}" fill="none" stroke="${col(s.p)}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C * s.p / 100} ${C}" transform="rotate(-90 50 50)"/><text x="50" y="56" text-anchor="middle" font-size="20" font-weight="700" fill="var(--head)">${s.p}%</text></svg>`;
  const need = s.p >= 75 ? Math.max(0, Math.floor(s.at / .75 - s.tot)) : Math.ceil((.75 * s.tot - s.at) / .25);
  const bars = s.v.map(a => `<div class="hb"><span>${a.n}</span><div class="bar"><div class="fill" style="width:${a.p}%;background:${col(a.p)}"></div><i class="mark"></i></div><b>${a.total ? a.p + '%' : '—'}</b></div>`).join('');
  let a = 0, t = 0, best = 0, run = 0; const pts = L.map(x => { t++; a += x.attended; run = x.attended ? run + 1 : 0; best = Math.max(best, run); return Math.round(a / t * 100); });
  const n = pts.length, line = n >= 2 ? `<svg viewBox="0 0 300 100" width="100%" height="90" preserveAspectRatio="none" role="img" aria-label="Attendance trend"><line x1="0" x2="300" y1="25" y2="25" stroke="var(--muted)" stroke-dasharray="4 4" opacity=".6"/><polyline fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" points="${pts.map((p, i) => `${(i * 300 / (n - 1)).toFixed(1)},${100 - p}`).join(' ')}"/></svg><p class="small">Trend since you started marking · dashed line = 75%</p>` : '<p class="small">Mark a few more classes to see your trend.</p>';
  $('ins').innerHTML = `<div class="ins-top">${donut}<div class="metrics" style="flex:1;margin:0"><div><b>${s.at}</b>Attended</div><div><b>${s.tot - s.at}</b>Bunked</div><div><b>${run}</b>Current streak</div><div><b>${best}</b>Best streak</div></div></div>
    <p class="small" style="margin:12px 0 4px">${s.p >= 75 ? `You can bunk <b>${need}</b> more class(es) overall and stay above 75%.` : `Attend the next <b>${need}</b> class(es) in a row to get back to 75%.`}</p>${bars}${line}`;
}

/* ---------- other pages ---------- */
function renderAnn() {
  $('acats').innerHTML = ['All', 'Academic', 'Exam', 'General'].map(c => `<button class="${c === cat ? 'on' : ''}" data-c="${c}">${c}</button>`).join('');
  const l = D.announcements.filter(a => cat === 'All' || a.cat === cat);
  $('alist').innerHTML = l.length ? l.map(a => `<div class="card glass" style="margin-bottom:14px">${acts('ann', a.id)}${a.pinned ? '<span class="pin">📌 PINNED</span> ' : ''}<span class="badge">${esc(a.cat)}</span>
    <h3 style="margin:8px 0 4px">${esc(a.title)}</h3><p>${esc(a.body)}</p><p class="small" style="margin-top:6px">${esc(a.author)} · ${fmt(a.created)}</p></div>`).join('') : '<p class="empty">Nothing here yet.</p>';
}
$('acats').onclick = e => { const b = e.target.closest('button'); if (b) { cat = b.dataset.c; renderAnn(); } };
function renderEv() {
  $('elist').innerHTML = D.events.length ? D.events.map(e => {
    const d = new Date(e.date + 'T00:00'), on = D.my_rsvps.includes(e.id), past = e.date < todayISO;
    return `<div class="card glass ev">${acts('event', e.id)}<div class="date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-IN', {month: 'short'})}</span></div>
      <h3>${esc(e.title)}</h3><p class="small">📍 ${esc(e.place || 'TBA')} · ${fmt(e.date, {weekday: 'long'})}</p><p class="small">👥 ${e.going} going</p>
      ${past ? '<span class="badge">Ended</span>' : `<button class="btn ${on ? 'att' : ''}" data-r="${e.id}" data-on="${on ? 1 : 0}">${on ? '✓ Going (tap to undo)' : 'I’m coming'}</button>`}</div>`;
  }).join('') : '<p class="empty">No events yet.</p>';
}
$('elist').onclick = e => { const r = e.target.closest('[data-r]'); if (r) act(() => api('PUT', '/rsvp/' + r.dataset.r, {going: r.dataset.on !== '1'})); };
function renderSocial() {
  const ico = u => /whatsapp/i.test(u) ? '💬' : /t\.me|telegram/i.test(u) ? '✈️' : /discord/i.test(u) ? '🎮' : /instagram/i.test(u) ? '📸' : /youtube|youtu\.be/i.test(u) ? '▶️' : '🔗';
  const l = D.links.filter(x => x.kind === 'social');
  $('slist').innerHTML = l.length ? l.map(x => `<div class="card glass soc">${acts('link', x.id)}<span class="ico">${ico(x.url)}</span><h3>${esc(x.title)}</h3><p class="small">${esc(x.note)}</p><a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Join</a></div>`).join('') : '<p class="empty">No groups added yet.</p>';
}

/* ---------- CR portal ---------- */
let ttDraft = [];
function readTT() { ttDraft = [...$('tt-edit').querySelectorAll('tbody tr')].map(tr => { const v = [...tr.querySelectorAll('input')].map(i => i.value.trim()); return [v[0], v.slice(1)]; }); }
function drawTT() {
  $('tt-edit').innerHTML = '<thead><tr><th>Time</th>' + DAYS.map(d => `<th>${d}</th>`).join('') + '<th></th></tr></thead><tbody>' +
    ttDraft.map((r, i) => `<tr><td><input value="${esc(r[0])}" maxlength="24" placeholder="09:00-10:00"></td>${r[1].map(c => `<td><input value="${esc(c)}" maxlength="30"></td>`).join('')}<td><button class="ed" data-tr="${i}" aria-label="Remove row">✕</button></td></tr>`).join('') + '</tbody>';
}
$('tt-edit').oninput = () => { ttDirty = true; };
$('tt-add').onclick = () => { readTT(); ttDraft.push(['', Array(7).fill('—')]); ttDirty = true; drawTT(); };
$('tt-save').onclick = () => { readTT(); act(async () => { await api('PUT', '/timetable', {rows: ttDraft}); ttDirty = false; }, 'Timetable saved'); };
function renderCR() {
  if (!ttDirty) { ttDraft = D.timetable.map(r => [r[0], [...r[1]]]); drawTT(); }
  loadPending(); if (U.role === 'admin') loadUsers();
}
async function loadPending() {
  try {
    const {pending} = await api('GET', '/pending');
    $('req').innerHTML = pending.length ? pending.map(u => `<div class="urow"><div><strong>${esc(u.name)}</strong><div class="small">${esc(u.email)}</div></div><div style="display:flex;gap:6px"><button class="btn att" data-ok="${u.id}">Approve</button><button class="btn bnk" data-no="${u.id}">Reject</button></div></div>`).join('') : '<p class="empty">No one is waiting.</p>';
  } catch (e) { toast(e.message); }
}
$('req').onclick = e => {
  const a = e.target.closest('[data-ok]'), r = e.target.closest('[data-no]');
  if (a) act(() => api('POST', `/users/${a.dataset.ok}/approve`), 'Approved');
  else if (r && confirm('Reject and delete this request?')) act(() => api('DELETE', `/users/${r.dataset.no}`), 'Removed');
};
async function loadUsers() {
  try {
    const {users} = await api('GET', '/users');
    $('users').innerHTML = users.map(u => `<div class="urow"><div><strong>${esc(u.name)}</strong>${u.approved ? '' : ' <span class="badge">pending</span>'}<div class="small">${esc(u.email)}</div></div>
      ${u.id === U.id ? '<span class="badge">You</span>' : `<select data-u="${u.id}" aria-label="Role for ${esc(u.name)}">${['student', 'cr', 'admin'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select><button class="btn" data-rmu="${u.id}">Remove</button>`}</div>`).join('');
  } catch (e) { toast(e.message); }
}
$('users').onclick = e => { const b = e.target.closest('[data-rmu]'); if (b && confirm('Remove this person? Their attendance and RSVPs are deleted too.')) act(() => api('DELETE', `/users/${b.dataset.rmu}`), 'Removed'); };
$('users').onchange = e => { const s = e.target.closest('[data-u]'); if (s) api('PUT', `/users/${s.dataset.u}/role`, {role: s.value}).then(() => toast('Role updated')).catch(x => { toast(x.message); loadUsers(); }); };

buildForms();
boot().catch(() => showAuth());
