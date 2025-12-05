const socket = io();

socket.on('scheduled-run', d => {
  const msg = `[${d.time}] Scheduled → ${d.script} executed!`;
  const v = document.getElementById('log-view');
  if (v) { v.textContent += '\n' + msg + '\n'; v.scrollTop = v.scrollHeight; }
  if (document.getElementById('logs').style.display === 'block') loadLogs();
});

function show(id) {
  document.querySelectorAll('section').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = 'block';
  if (id === 'scripts') loadScripts();
  if (id === 'schedule') loadSchedules();
  if (id === 'logs') loadLogs();
  if (id === 'run') loadScriptList();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return await res.json();
}

async function loadScriptList() {
  const scripts = await fetchJSON('/api/scripts');
  const sel = document.getElementById('select-script');
  sel.innerHTML = '<option value="">New Script</option>';
  scripts.forEach(s => sel.add(new Option(s, s)));
}
async function loadScript() {
  const name = document.getElementById('select-script').value;
  if (!name) { document.getElementById('code').value = ''; return; }
  const data = await fetchJSON(`/api/scripts/${name}`);
  document.getElementById('code').value = data.content || '';
}
function runNow() {
  const code = document.getElementById('code').value;
  const name = (document.getElementById('select-script').value || 'temp').split('.')[0];
  const type = document.getElementById('type').value;
  const outputEl = document.getElementById('output');
  const errorEl = document.getElementById('error');
  outputEl.textContent = ''; errorEl.textContent = '';
  socket.off('output'); socket.off('error'); socket.off('complete');
  socket.emit('run', { content: code, name, type });
  socket.on('output', d => { outputEl.textContent += d; outputEl.scrollTop = outputEl.scrollHeight; });
  socket.on('error', d => { errorEl.textContent += d; errorEl.scrollTop = errorEl.scrollHeight; });
  socket.on('complete', d => {
    outputEl.textContent += `\n\nFinished — ${d.success ? 'SUCCESS' : 'FAILED'}\n`;
    alert(d.success ? 'Success!' : 'Failed');
  });
}

async function loadScripts() {
  const scripts = await fetchJSON('/api/scripts');
  const list = document.getElementById('script-list');
  list.innerHTML = '';
  scripts.forEach(s => {
    const li = document.createElement('li');
    li.innerHTML = `${s} <button onclick="edit('${s}')">Edit</button> <button onclick="del('${s}')">Delete</button>`;
    list.appendChild(li);
  });
}
function saveScript() {
  const name = document.getElementById('new-name').value.trim();
  const code = document.getElementById('new-code').value;
  if (!name) return alert('Enter filename');
  fetch('/api/scripts', { method: 'POST', body: JSON.stringify({ name, content: code }), headers: {'Content-Type':'application/json'} })
    .then(() => { loadScripts(); document.getElementById('new-name').value = ''; document.getElementById('new-code').value = ''; });
}
function edit(name) { fetch(`/api/scripts/${name}`).then(r => r.json()).then(d => { document.getElementById('new-name').value = name; document.getElementById('new-code').value = d.content; }); }
function del(name) { if (confirm('Delete?')) fetch(`/api/scripts/${name}`, { method: 'DELETE' }).then(loadScripts); }

async function loadSchedules() {
  const [scripts, schs] = await Promise.all([fetchJSON('/api/scripts'), fetchJSON('/api/schedules')]);
  document.getElementById('sch-script').innerHTML = scripts.map(s => `<option>${s}</option>`).join('');
  const list = document.getElementById('schedule-list');
  list.innerHTML = '';
  for (const s of schs) {
    const info = await fetchJSON(`/api/validate-cron?expr=${encodeURIComponent(s.cron)}`);
    const isValid = info.valid;
    const countdown = isValid && info.next ? formatCountdown(new Date(info.next)) : 'Never';
    const li = document.createElement('li');
    li.style.borderLeft = `5px solid ${isValid ? '#27ae60' : '#e74c3c'}`;
    li.style.background = isValid ? '#f8fff8' : '#fff8f8';
    li.innerHTML = `
      <div style="flex:1"><strong>${s.scriptName}</strong> → ${s.cron}<br><small>${s.emailTo || 'No email'}</small></div>
      <div style="text-align:right">
        <div style="color:${isValid ? '#27ae60' : '#e74c3c'}; font-weight:bold;">${isValid ? 'Running' : 'Invalid cron'}</div>
        <div>Next: ${countdown}</div>
      </div>
      <button onclick="delSch('${s.id}')">Delete</button>
    `;
    list.appendChild(li);
  }
  setTimeout(loadSchedules, 5000);
}
function formatCountdown(date) {
  const diff = date - new Date();
  if (diff <= 0) return 'Now!';
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function addSchedule() {
  const data = {
    scriptName: document.getElementById('sch-script').value,
    cron: document.getElementById('sch-cron').value.trim(),
    emailTo: document.getElementById('sch-email').value,
    emailOnSuccess: document.getElementById('email-success').checked,
    emailOnFailure: document.getElementById('email-failure').checked,
  };
  if (!data.scriptName || !data.cron) return alert('Fill script + cron');
  fetch('/api/schedules', { method: 'POST', body: JSON.stringify(data), headers: {'Content-Type':'application/json'} })
    .then(() => { document.getElementById('sch-cron').value = ''; loadSchedules(); });
}
function delSch(id) { fetch(`/api/schedules/${id}`, { method: 'DELETE' }).then(loadSchedules); }

async function loadLogs() {
  const logs = await fetchJSON('/api/logs');
  const list = document.getElementById('log-list');
  list.innerHTML = '';
  logs.forEach(l => {
    const li = document.createElement('li');
    li.innerHTML = `${l.timestamp.replace('T',' ').split('.')[0]} - ${l.scriptName} <button onclick="viewLog('${l.file}')">View</button>`;
    list.appendChild(li);
  });
}
function viewLog(file) { fetch(`/api/logs/${file}`).then(r => r.text()).then(t => document.getElementById('log-view').textContent = t); }

show('run');
