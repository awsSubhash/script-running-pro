const socket = io();

socket.on('scheduled-run', d => {
  addLogMessage(`[${d.time}] Scheduled → ${d.script} executed!`);
  if (document.getElementById('logs').style.display !== 'none') loadLogs();
});

function addLogMessage(msg) {
  const v = document.getElementById('log-view');
  if (v) {
    v.textContent += '\n' + msg + '\n';
    v.scrollTop = v.scrollHeight;
  }
}

function show(id) {
  document.querySelectorAll('section').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = 'block';
  if (id === 'scripts') loadScripts();
  if (id === 'schedule') initScheduleTab();
  if (id === 'logs') loadLogs();
  if (id === 'run') loadScriptList();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Not found');
  return await res.json();
}

// ====================== RUN TAB ======================
async function loadScriptList() {
  const scripts = await fetchJSON('/api/scripts');
  const sel = document.getElementById('select-script');
  sel.innerHTML = '<option value="">New Script</option>';
  scripts.forEach(s => sel.add(new Option(s, s)));
}

async function loadScript() {
  const name = document.getElementById('select-script').value;
  if (!name) {
    document.getElementById('code').value = '';
    return;
  }
  const data = await fetchJSON(`/api/scripts/${name}`);
  document.getElementById('code').value = data.content || '';
}

function runNow() {
  const code = document.getElementById('code').value;
  const name = (document.getElementById('select-script').value || 'temp').split('.')[0] || 'temp';
  const type = document.getElementById('type').value;
  const outputEl = document.getElementById('output');
  const errorEl = document.getElementById('error');
  outputEl.textContent = '';
  errorEl.textContent = '';

  socket.off('output error complete');
  socket.emit('run', { content: code, name, type });

  socket.on('output', d => { outputEl.textContent += d; outputEl.scrollTop = outputEl.scrollHeight; });
  socket.on('error', d => { errorEl.textContent += d; errorEl.scrollTop = errorEl.scrollHeight; });
  socket.on('complete', () => {
    outputEl.textContent += '\n\nFinished\n';
  });
}

// ====================== SCRIPTS TAB ======================
async function loadScripts() {
  const scripts = await fetchJSON('/api/scripts');
  const list = document.getElementById('script-list');
  list.innerHTML = '';
  scripts.forEach(s => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="script-name">${s}</span>
      <div>
        <button onclick="edit('${s}')">Edit</button>
        <button class="danger" onclick="del('${s}')">Delete</button>
      </div>
    `;
    list.appendChild(li);
  });
}

function saveScript() {
  const name = document.getElementById('new-name').value.trim();
  const code = document.getElementById('new-code').value;
  if (!name) return alert('Enter filename');
  fetch('/api/scripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content: code })
  }).then(() => {
    loadScripts();
    document.getElementById('new-name').value = '';
    document.getElementById('new-code').value = '';
  });
}

function edit(name) {
  fetch(`/api/scripts/${name}`).then(r => r.json()).then(d => {
    document.getElementById('new-name').value = name;
    document.getElementById('new-code').value = d.content;
  });
}

function del(name) {
  if (confirm('Delete script?')) fetch(`/api/scripts/${name}`, { method: 'DELETE' }).then(loadScripts);
}

// ====================== SCHEDULE TAB (SMOOTH) ======================
let currentSchedules = [];
let countdownInterval = null;

async function initScheduleTab() {
  await loadSchedulesOnce();
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdowns, 1000);
}

async function loadSchedulesOnce() {
  const [scripts, schs] = await Promise.all([
    fetchJSON('/api/scripts'),
    fetchJSON('/api/schedules')
  ]);

  currentSchedules = schs;
  document.getElementById('sch-script').innerHTML = scripts.map(s => `<option>${s}</option>`).join('');

  const container = document.getElementById('schedule-list');
  container.innerHTML = '';

  if (schs.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:2rem;font-style:italic;">No scheduled jobs yet</p>';
    return;
  }

  schs.forEach(s => {
    const card = document.createElement('div');
    card.className = 'schedule-card';
    card.dataset.id = s.id;

    const isValid = isCronValid(s.cron);
    const status = s.paused ? 'PAUSED' : (isValid ? 'ACTIVE' : 'INVALID');
    const color = s.paused ? '#f39c12' : (isValid ? '#27ae60' : '#e74c3c');

    card.innerHTML = `
      <div class="schedule-header">
        <div>
          <strong>${escapeHtml(s.scriptName)}</strong>
          <code class="cron">${escapeHtml(s.cron)}</code>
        </div>
        <span class="badge" style="background:${color}">${status}</span>
      </div>
      <div class="schedule-info">
        ${s.emailTo ? `Email: ${escapeHtml(s.emailTo)}` : '<em>No email notifications</em>'}
      </div>
      <div class="schedule-next" id="next-${s.id}">Calculating...</div>
      <div class="schedule-actions">
        ${s.paused
          ? `<button class="btn-resume" onclick="resumeSch('${s.id}')">Resume</button>`
          : `<button class="btn-pause" onclick="pauseSch('${s.id}')">Pause</button>`
        }
        <button class="btn-run-now" onclick="runNowSch('${s.id}')">Run Now</button>
        <button class="btn-delete" onclick="delSch('${s.id}')">Delete</button>
      </div>
    `;
    container.appendChild(card);
  });

  updateCountdowns();
}

function isCronValid(cronExpr) {
  try {
    CronExpressionParser.parse(cronExpr, { currentDate: new Date() });
    return true;
  } catch { return false; }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function updateCountdowns() {
  for (const s of currentSchedules) {
    const el = document.getElementById(`next-${s.id}`);
    if (!el) continue;

    if (s.paused) {
      el.textContent = 'Paused';
      continue;
    }

    try {
      const res = await fetch(`/api/validate-cron?expr=${encodeURIComponent(s.cron)}`);
      const data = await res.json();
      if (data.valid && data.next) {
        const diff = new Date(data.next) - new Date();
        if (diff <= 0) el.textContent = 'Running now...';
        else if (diff < 60000) el.textContent = `In ${Math.round(diff/1000)}s`;
        else {
          const m = Math.floor(diff / 60000);
          const s = Math.floor((diff % 60000) / 1000);
          el.textContent = `In ${m}m ${s}s`;
        }
      } else {
        el.textContent = 'Invalid cron';
      }
    } catch {
      el.textContent = 'Error';
    }
  }
}

function addSchedule() {
  const data = {
    scriptName: document.getElementById('sch-script').value,
    cron: document.getElementById('sch-cron').value.trim(),
    emailTo: document.getElementById('sch-email').value.trim(),
    emailOnSuccess: document.getElementById('email-success').checked,
    emailOnFailure: document.getElementById('email-failure').checked,
  };
  if (!data.scriptName || !data.cron) return alert('Script and cron required');

  fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(() => {
    document.getElementById('sch-cron').value = '';
    document.getElementById('sch-email').value = '';
    loadSchedulesOnce();
  });
}

function pauseSch(id) { if (confirm('Pause job?')) action(id, 'pause'); }
function resumeSch(id) { action(id, 'resume'); }
function runNowSch(id) { if (confirm('Run now?')) action(id, 'run-now'); }
function delSch(id) { if (confirm('Delete?')) fetch(`/api/schedules/${id}`, { method: 'DELETE' }).then(loadSchedulesOnce); }

function action(id, act) {
  fetch(`/api/schedules/${id}/${act}`, { method: 'POST' })
    .then(() => loadSchedulesOnce());
}

// ====================== LOGS TAB - FIXED & BEAUTIFUL DATES ======================
async function loadLogs() {
  try {
    const logs = await fetchJSON('/api/logs');
    const list = document.getElementById('log-list');
    list.innerHTML = '';

    if (logs.length === 0) {
      list.innerHTML = '<li style="text-align:center;color:#999;padding:1rem;">No logs yet</li>';
      return;
    }

    logs.forEach(l => {
      const li = document.createElement('li');

      // PERFECT DATE PARSING – handles 2025-12-05T10-30-45-123Z format
      const cleanTs = l.timestamp.replace(/-/g, ':');
      const dateObj = new Date(cleanTs);
      const dateStr = isNaN(dateObj.getTime()) 
        ? 'Just now' 
        : dateObj.toLocaleDateString(undefined, { 
            day: 'numeric', month: 'short', year: 'numeric' 
          }) + ', ' + 
          dateObj.toLocaleTimeString(undefined, { 
            hour: '2-digit', minute: '2-digit', second: '2-digit' 
          });

      li.innerHTML = `
        <div>
          <strong>${escapeHtml(l.scriptName)}</strong><br>
          <small style="color:#7f8c8d">${dateStr}</small>
        </div>
        <button onclick="viewLog('${l.file}')">View Log</button>
      `;
      list.appendChild(li);
    });
  } catch (e) {
    console.error('Failed to load logs:', e);
  }
}

async function viewLog(file) {
  const viewer = document.getElementById('log-view');
  viewer.textContent = 'Loading log file...';

  try {
    const res = await fetch(`/api/logs/${file}`);
    if (!res.ok) throw new Error('Log not found');
    const text = await res.text();

    viewer.textContent = text || '(empty log)';
    viewer.scrollTop = 0;
    viewer.style.background = '#2c3e50';
    viewer.style.color = '#f8f9fa';
  } catch (err) {
    viewer.textContent = `Error: Could not load log file\n${err.message}`;
    viewer.style.background = '#fdf2f2';
    viewer.style.color = '#e74c3c';
  }
}

// Start
show('run');
