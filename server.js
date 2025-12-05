const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cron = require('node-cron');
const { isValidCron } = require('cron-validator');
const { CronExpressionParser } = require('cron-parser');  // ← FIXED: Named import for v5.4.0+
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3000;
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const LOGS_DIR = path.join(__dirname, 'logs');
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

// Create folders if missing
[SCRIPTS_DIR, LOGS_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]');

// Load schedules
let schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8') || '[]');
let cronJobs = {};

// ─────────────────────────────────────────────────────────────────────────────
// Run any script (manual or scheduled)
function runScript(scriptPath, scriptName, socketId = null, emailOptions = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOGS_DIR, `${timestamp}_${scriptName}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  let output = '', error = '';

  const ext = path.extname(scriptPath).toLowerCase();
  const cmd = ext === '.sh' ? `bash "${scriptPath}"`
            : ext === '.py' ? `python3 "${scriptPath}" || python "${scriptPath}"`
            : `"${scriptPath}"`;

  const child = exec(cmd, { timeout: 300000 }); // 5 minute timeout

  child.stdout?.on('data', d => {
    const t = d.toString();
    output += t;
    logStream.write(t);
    if (socketId) io.to(socketId).emit('output', t);
  });

  child.stderr?.on('data', d => {
    const t = d.toString();
    error += t;
    logStream.write(t);
    if (socketId) io.to(socketId).emit('error', t);
  });

  child.on('close', code => {
    logStream.end();
    const success = code === 0;

    if (socketId) io.to(socketId).emit('complete', { success, code });

    // Email notification if configured
    if (emailOptions?.to && ((success && emailOptions.onSuccess) || (!success && emailOptions.onFailure))) {
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      transporter.sendMail({
        from: 'Script Runner <no-reply@runner.com>',
        to: emailOptions.to,
        subject: `${success ? 'SUCCESS' : 'FAILED'} - ${scriptName}`,
        text: `Exit code: ${code}\n\nSTDOUT:\n${output}\n\nSTDERR:\n${error}`
      }).catch(err => console.error('Email send failed:', err));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reload all scheduled jobs
function reloadSchedules() {
  Object.values(cronJobs).forEach(j => j.stop());
  cronJobs = {};

  schedules.forEach(sch => {
    if (!sch.cron || !sch.scriptName) return;

    const job = cron.schedule(sch.cron, () => {
      const scriptPath = path.join(SCRIPTS_DIR, sch.scriptName);
      if (fs.existsSync(scriptPath)) {
        console.log(`Scheduled run: ${sch.scriptName} @ ${sch.cron}`);
        runScript(scriptPath, sch.scriptName, null, {
          to: sch.emailTo || '',
          onSuccess: sch.emailOnSuccess || false,
          onFailure: sch.emailOnFailure || false
        });
        io.emit('scheduled-run', { script: sch.scriptName, time: new Date().toLocaleString() });
      }
    }, { scheduled: true });

    cronJobs[sch.id] = job;
  });
}

reloadSchedules();

// ─────────────────────────────────────────────────────────────────────────────
// Express routes
app.use(express.static('public'));
app.use(express.json());

// FIXED: Works with cron-parser v5.4.0+ and node-cron 3.0.3
app.get('/api/validate-cron', (req, res) => {
  const expr = req.query.expr?.trim();
  if (!expr) return res.json({ valid: false, next: null });

  const valid = isValidCron(expr, { seconds: true, alias: true, allowBlankDay: true });

  let next = null;
  if (valid) {
    try {
      const options = { currentDate: new Date(), tz: 'UTC' }; // Change tz if needed (e.g., 'America/New_York')
      const interval = CronExpressionParser.parse(expr, options);
      next = interval.next().toDate().toISOString();
    } catch (e) {
      console.warn('cron-parser failed on:', expr, e.message);
      // some expressions pass validator but fail parser → treat as invalid
      return res.json({ valid: false, next: null });
    }
  }

  res.json({ valid, next });
});

app.get('/api/scripts', (req, res) => {
  fs.readdir(SCRIPTS_DIR, (err, files) => {
    if (err) return res.json([]);
    const filtered = files.filter(f => !f.startsWith('.'));
    res.json(filtered);
  });
});

app.get('/api/scripts/:name', (req, res) => {
  const filePath = path.join(SCRIPTS_DIR, req.params.name);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Not found' });
    res.json({ content: data });
  });
});

app.post('/api/scripts', (req, res) => {
  const { name, content } = req.body;
  if (!name) return res.status(400).json({ success: false });
  fs.writeFile(path.join(SCRIPTS_DIR, name), content, err => {
    res.json({ success: !err });
  });
});

app.delete('/api/scripts/:name', (req, res) => {
  fs.unlink(path.join(SCRIPTS_DIR, req.params.name), () => {
    res.json({ success: true });
  });
});

app.get('/api/logs', (req, res) => {
  fs.readdir(LOGS_DIR, (err, files) => {
    if (err) return res.json([]);
    const logs = files
      .filter(f => f.endsWith('.log'))
      .map(file => {
        const parts = file.split('_');
        const timestamp = parts[0];
        const scriptName = parts.slice(1).join('_').replace('.log', '');
        return { file, timestamp, scriptName };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(logs);
  });
});

app.get('/api/logs/:file', (req, res) => {
  res.sendFile(path.join(LOGS_DIR, req.params.file));
});

app.get('/api/schedules', (req, res) => res.json(schedules));

app.post('/api/schedules', (req, res) => {
  const newSch = { id: Date.now().toString(), ...req.body };
  schedules = schedules.filter(s => s.id !== newSch.id); // upsert
  schedules.push(newSch);
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  reloadSchedules();
  res.json({ success: true });
});

app.delete('/api/schedules/:id', (req, res) => {
  schedules = schedules.filter(s => s.id !== req.params.id);
  if (cronJobs[req.params.id]) {
    cronJobs[req.params.id].stop();
    delete cronJobs[req.params.id];
  }
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO – manual run from UI
io.on('connection', socket => {
  socket.on('run', data => {
    const { content, name, type } = data;
    const fileName = `${name}.${type}`;
    const filePath = path.join(SCRIPTS_DIR, fileName);

    fs.writeFileSync(filePath, content);
    runScript(filePath, name, socket.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Script Runner PRO → http://localhost:${PORT}`);
  console.log(`Access from your browser: http://YOUR_SERVER_IP:${PORT}`);
});
