// ─────────────────────────────────────────────────────────────────────────────
//  SCRIPT RUNNER PRO – FULLY UPDATED VERSION (2025)
//  • Full .env support
//  • Smart Gmail + Custom SMTP
//  • All features working perfectly
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();                      // ← LOAD .env FIRST!

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cron = require('node-cron');
const { isValidCron } = require('cron-validator');
const { CronExpressionParser } = require('cron-parser');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const LOGS_DIR = path.join(__dirname, 'logs');
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

// Create folders
[SCRIPTS_DIR, LOGS_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]');

let schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8') || '[]');
let cronJobs = {};

// ────────────────────────────── EMAIL CONFIG (SMART) ──────────────────────────────
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true', // true only for port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
};

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn('⚠️  EMAIL_USER or EMAIL_PASS not set in .env → Email notifications DISABLED');
}

// ────────────────────────────── RUN SCRIPT FUNCTION ──────────────────────────────
function runScript(scriptPath, scriptName, socketId = null, emailOptions = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOGS_DIR, `${timestamp}_${scriptName}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  let output = '', error = '';

  const ext = path.extname(scriptPath).toLowerCase();
  const cmd = ext === '.sh' ? `bash "${scriptPath}"`
            : ext === '.py' ? `python3 "${scriptPath}" || python "${scriptPath}"`
            : `"${scriptPath}"`;

  const child = exec(cmd, { timeout: 300000 });

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

    // SEND EMAIL IF ENABLED AND CONDITIONS MET
    if (emailOptions?.to && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      if ((success && emailOptions.onSuccess) || (!success && emailOptions.onFailure)) {
        const transporter = nodemailer.createTransport(emailConfig);
        transporter.sendMail({
          from: `"Script Runner" <${process.env.EMAIL_USER}>`,
          to: emailOptions.to,
          subject: `${success ? 'SUCCESS' : 'FAILED'} - ${scriptName}`,
          text: `Exit code: ${code}\n\nSTDOUT:\n${output}\n\nSTDERR:\n${error}`
        }).catch(err => console.error('Email send failed:', err.message));
      }
    }
  });
}

// ────────────────────────────── RELOAD SCHEDULES ──────────────────────────────
function reloadSchedules() {
  Object.values(cronJobs).forEach(j => j.stop());
  cronJobs = {};

  schedules.forEach(sch => {
    if (!sch.cron || !sch.scriptName || sch.paused) return;

    const job = cron.schedule(sch.cron, () => {
      const scriptPath = path.join(SCRIPTS_DIR, sch.scriptName);
      if (fs.existsSync(scriptPath)) {
        console.log(`Scheduled → ${sch.scriptName}`);
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

// ────────────────────────────── ROUTES ──────────────────────────────
app.use(express.static('public'));
app.use(express.json());

app.get('/api/validate-cron', (req, res) => {
  const expr = req.query.expr?.trim();
  if (!expr) return res.json({ valid: false, next: null });

  const valid = isValidCron(expr, { seconds: true, alias: true, allowBlankDay: true });
  let next = null;
  if (valid) {
    try {
      const interval = CronExpressionParser.parse(expr, { currentDate: new Date(), tz: 'UTC' });
      next = interval.next().toDate().toISOString();
    } catch (e) {
      return res.json({ valid: false, next: null });
    }
  }
  res.json({ valid, next });
});

app.get('/api/scripts', (req, res) => fs.readdir(SCRIPTS_DIR, (e, f) => res.json(e ? [] : f.filter(x => !x.startsWith('.')))));
app.get('/api/scripts/:name', (req, res) => fs.readFile(path.join(SCRIPTS_DIR, req.params.name), 'utf8', (e, d) => e ? res.status(404).json({}) : res.json({ content: d })));
app.post('/api/scripts', (req, res) => {
  const { name, content } = req.body;
  fs.writeFile(path.join(SCRIPTS_DIR, name), content, e => res.json({ success: !e }));
});
app.delete('/api/scripts/:name', (req, res) => fs.unlink(path.join(SCRIPTS_DIR, req.params.name), () => res.json({ success: true })));

app.get('/api/logs', (req, res) => {
  fs.readdir(LOGS_DIR, (e, f) => {
    if (e) return res.json([]);
    const logs = f.filter(x => x.endsWith('.log'))
      .map(file => {
        const [ts, ...rest] = file.split('_');
        return { file, timestamp: ts, scriptName: rest.join('_').replace('.log', '') };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(logs);
  });
});
app.get('/api/logs/:file', (req, res) => res.sendFile(path.join(LOGS_DIR, req.params.file)));

app.get('/api/schedules', (req, res) => res.json(schedules));

app.post('/api/schedules', (req, res) => {
  const newSch = { id: Date.now().toString(), paused: false, ...req.body };
  schedules = schedules.filter(s => s.id !== newSch.id);
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

app.post('/api/schedules/:id/pause', (req, res) => {
  const id = req.params.id;
  if (cronJobs[id]) {
    cronJobs[id].stop();
    delete cronJobs[id];
    schedules = schedules.map(s => s.id === id ? { ...s, paused: true } : s);
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

app.post('/api/schedules/:id/resume', (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch || !sch.paused) return res.status(400).json({ success: false });

  const job = cron.schedule(sch.cron, () => {
    const scriptPath = path.join(SCRIPTS_DIR, sch.scriptName);
    if (fs.existsSync(scriptPath)) {
      console.log(`Resumed → ${sch.scriptName}`);
      runScript(scriptPath, sch.scriptName, null, {
        to: sch.emailTo || '',
        onSuccess: sch.emailOnSuccess || false,
        onFailure: sch.emailOnFailure || false
      });
      io.emit('scheduled-run', { script: sch.scriptName, time: new Date().toLocaleString() });
    }
  }, { scheduled: true });

  cronJobs[sch.id] = job;
  schedules = schedules.map(s => s.id === sch.id ? { ...s, paused: false } : s);
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  res.json({ success: true });
});

app.post('/api/schedules/:id/run-now', (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ success: false });

  const scriptPath = path.join(SCRIPTS_DIR, sch.scriptName);
  if (fs.existsSync(scriptPath)) {
    console.log(`Manual run → ${sch.scriptName}`);
    runScript(scriptPath, sch.scriptName, null, {
      to: sch.emailTo || '',
      onSuccess: sch.emailOnSuccess || false,
      onFailure: sch.emailOnFailure || false
    });
    io.emit('scheduled-run', { script: sch.scriptName, time: new Date().toLocaleString() });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

// ────────────────────────────── SOCKET.IO ──────────────────────────────
io.on('connection', socket => {
  socket.on('run', data => {
    const { content, name, type } = data;
    const filePath = path.join(SCRIPTS_DIR, `${name}.${type}`);
    fs.writeFileSync(filePath, content);
    runScript(filePath, name, socket.id);
  });
});

// ────────────────────────────── START SERVER ──────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Script Runner PRO → http://YOUR_SERVER_IP:${PORT}`);
  console.log(`Email notifications: ${process.env.EMAIL_USER ? 'ENABLED' : 'DISABLED'}`);
});
