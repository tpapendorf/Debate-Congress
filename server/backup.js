'use strict';
// Backups: a clean, compressed copy of the database once a day (when anything changed), on demand, and before a restore.
// Admins can download copies, export everything as spreadsheets, and restore (the app restarts with the restored data).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const KEEP_DAYS = 14;
const KEEP_MIN = 5;
const DAY = 24 * 3600 * 1000;
const NAME_RE = /^congress-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?-(daily|manual|pre-restore|upload)\.db\.gz$/;

// ---------- a tiny zip writer (stored, no compression), enough for a folder of CSV files ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// Spreadsheets for "Export everything". Passwords, sessions and people's private prep (speech plans, notes,
// personal trackers, practice ballots) are left out; they are still in the full backups.
const EXPORT = [
  ['people', 'SELECT id, username, display_name, school, role, created_at FROM users ORDER BY id'],
  ['chambers', 'SELECT id, name, status, floor_mode, po_user_id, score_min, score_max, rank_count, speech_seconds, authorship_question_seconds, question_seconds, is_mock, standings_publish, created_at FROM chambers ORDER BY id'],
  ['chamber_members', 'SELECT * FROM chamber_members ORDER BY chamber_id, seat'],
  ['legislation', 'SELECT * FROM legislation ORDER BY chamber_id, docket_order, id'],
  ['speeches', 'SELECT * FROM speeches ORDER BY chamber_id, recognized_at'],
  ['questions', 'SELECT * FROM questions ORDER BY chamber_id, asked_at'],
  ['speech_scores', 'SELECT * FROM speech_scores ORDER BY speech_id, judge_id'],
  ['question_scores', `SELECT qs.* FROM question_scores qs JOIN users u ON u.id = qs.scorer_id WHERE u.role = 'judge' ORDER BY question_id`],
  ['po_scores', 'SELECT * FROM po_scores ORDER BY chamber_id'],
  ['rankings', 'SELECT * FROM rankings ORDER BY chamber_id, judge_id, rank'],
  ['judge_ballots', 'SELECT * FROM judge_ballots ORDER BY chamber_id'],
  ['motions', 'SELECT * FROM motions ORDER BY chamber_id, created_at'],
  ['votes', 'SELECT * FROM vote_rounds ORDER BY chamber_id, opened_at'],
  ['announcements', 'SELECT * FROM announcements ORDER BY chamber_id, created_at'],
  ['teams', 'SELECT id, name, school, created_at FROM teams ORDER BY id'],
  ['team_members', 'SELECT * FROM team_members ORDER BY team_id'],
  ['team_bills', 'SELECT * FROM team_bills ORDER BY team_id, id'],
  ['team_research', 'SELECT * FROM bill_items ORDER BY bill_id, id'],
  ['team_links', 'SELECT * FROM team_links WHERE plan_id IS NULL ORDER BY team_id, id'],
  ['team_progress', 'SELECT * FROM progress_entries ORDER BY team_id, user_id'],
  ['team_goals', 'SELECT * FROM team_goals ORDER BY team_id, user_id'],
  ['training_lessons', 'SELECT * FROM lessons ORDER BY team_id, track, sort, id'],
  ['training_done', 'SELECT * FROM lesson_done ORDER BY lesson_id, user_id'],
];
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
};

module.exports = function mountBackups(app, h) {
  const { getDb, q, wrap, requireAdmin, bad, notFound } = h;
  const dbFile = h.dbFile && h.dbFile !== ':memory:' ? h.dbFile : null;
  const dir = h.backupDir || process.env.BACKUP_DIR || (dbFile ? path.join(path.dirname(dbFile), 'backups') : path.join(os.tmpdir(), 'congress-backups'));
  fs.mkdirSync(dir, { recursive: true });

  const list = () => fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, created_at: st.mtimeMs, reason: name.match(NAME_RE)[2] };
  }).sort((a, b) => b.created_at - a.created_at);

  function prune() {
    const all = list();
    all.forEach((b, i) => { if (i >= KEEP_MIN && Date.now() - b.created_at > KEEP_DAYS * DAY) fs.rmSync(path.join(dir, b.name), { force: true }); });
  }
  let changesAtLastBackup = -1;
  const changes = () => q('SELECT total_changes() n').get().n;
  function create(reason) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    let name = `congress-${stamp}-${reason}.db.gz`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `congress-${stamp}-${i}-${reason}.db.gz`;
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);
    try {
      getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // a consistent copy, safe while the app runs
      fs.writeFileSync(path.join(dir, name), zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
    } finally { fs.rmSync(tmp, { force: true }); }
    changesAtLastBackup = changes();
    prune();
    return list().find((b) => b.name === name);
  }
  // Once a day, if anything changed since the last copy.
  function tick() {
    try {
      const last = list().find((b) => b.reason !== 'upload');
      if (last && Date.now() - last.created_at < DAY - 10 * 60 * 1000) return;
      if (last && changes() === changesAtLastBackup) return;
      if (!last && q('SELECT COUNT(*) n FROM users').get().n === 0) return;
      create('daily');
    } catch (e) { console.error('Backup failed:', e.message); }
  }
  const timer = setInterval(tick, 30 * 60 * 1000);
  timer.unref();
  const first = setTimeout(tick, 60 * 1000);
  first.unref();

  // A restore file must be a Congress Chamber database with at least one admin.
  function checkDatabase(buf) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw bad('That file is not a Congress Chamber backup.');
    const tmp = path.join(dir, `.check-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(tmp, buf);
    try {
      const t = new DatabaseSync(tmp, { readOnly: true });
      try {
        const admins = t.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin'`).get().n;
        t.prepare('SELECT COUNT(*) n FROM chambers').get();
        if (!admins) throw bad('That backup has no admin account, so nobody could sign in after restoring it.');
      } catch (e) { if (e.status) throw e; throw bad('That file is not a Congress Chamber backup.'); } finally { t.close(); }
    } finally { fs.rmSync(tmp, { force: true }); }
    return buf;
  }

  const human = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  app.get('/api/admin/backups', wrap((req) => {
    requireAdmin(req);
    const backups = list();
    let disk = null;
    try { const st = fs.statfsSync(dir); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch { /* not available */ }
    const dbBytes = dbFile && fs.existsSync(dbFile) ? fs.statSync(dbFile).size : null;
    return {
      backups, total_bytes: backups.reduce((a, b) => a + b.size, 0), db_bytes: dbBytes, disk, keep_days: KEEP_DAYS,
      can_restore: !!dbFile, summary: `${backups.length} backups using ${human(backups.reduce((a, b) => a + b.size, 0))}`,
    };
  }));
  app.post('/api/admin/backups', wrap((req) => { requireAdmin(req); return { backup: create('manual') }; }));
  app.get('/api/admin/backups/:name', wrap((req, res) => {
    requireAdmin(req);
    const name = String(req.params.name);
    if (!NAME_RE.test(name) || !fs.existsSync(path.join(dir, name))) throw notFound('Backup not found.');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(fs.readFileSync(path.join(dir, name)));
  }));
  app.get('/api/admin/export.zip', wrap((req, res) => {
    requireAdmin(req);
    const files = [];
    for (const [name, sql] of EXPORT) {
      let rows;
      try { rows = q(sql).all(); } catch { continue; } // a table this database doesn't have yet
      const cols = rows.length ? Object.keys(rows[0]) : q(sql.replace(/ORDER BY.*$/, 'LIMIT 0')).columns?.().map((c) => c.name) || [];
      const text = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      files.push({ name: `${name}.csv`, data: Buffer.from('﻿' + text, 'utf8') });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    files.push({ name: 'README.txt', data: Buffer.from(`Congress Chamber export, ${new Date().toISOString()}\r\nOne spreadsheet per table. Times are milliseconds since 1970 (UTC).\r\nPasswords, private speech plans, notes, personal trackers and practice ballots are not included; they are in the full backups.\r\n`) });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="congress-export-${stamp}.zip"`);
    res.send(zip(files));
  }));
  // Restore from a stored backup ({ name }) or an uploaded file (raw body). The current data is backed up first,
  // the file is staged next to the database, and the database is reopened with it (see db.js).
  app.post('/api/admin/restore', express.raw({ type: ['application/octet-stream', 'application/gzip', 'application/x-sqlite3'], limit: '300mb' }), wrap((req) => {
    requireAdmin(req);
    if (!dbFile) throw bad('Restoring is only available when the app uses a database file.');
    let buf;
    if (Buffer.isBuffer(req.body) && req.body.length) {
      buf = checkDatabase(req.body);
      fs.writeFileSync(path.join(dir, `congress-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-upload.db.gz`), zlib.gzipSync(buf));
    } else {
      const name = String(req.query.name || (req.body && req.body.name) || '');
      if (!NAME_RE.test(name) || !fs.existsSync(path.join(dir, name))) throw notFound('Backup not found.');
      buf = checkDatabase(fs.readFileSync(path.join(dir, name)));
    }
    create('pre-restore');
    fs.writeFileSync(`${dbFile}.restore`, buf);
    h.reopen();
    changesAtLastBackup = -1;
    return { ok: true };
  }));

  return { create, list, stop: () => { clearInterval(timer); clearTimeout(first); }, zip, crc32 };
};
module.exports.zip = zip;
module.exports.crc32 = crc32;
