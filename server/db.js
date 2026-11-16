'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'congress.db');

function open(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      school TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('admin','judge','competitor')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chambers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','in_session','recess','adjourned')),
      po_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      current_legislation_id INTEGER,
      current_speech_id INTEGER,
      score_min INTEGER NOT NULL DEFAULT 1,
      score_max INTEGER NOT NULL DEFAULT 6,
      rank_count INTEGER NOT NULL DEFAULT 8,
      speech_seconds INTEGER NOT NULL DEFAULT 180,
      authorship_question_seconds INTEGER NOT NULL DEFAULT 120,
      question_seconds INTEGER NOT NULL DEFAULT 60,
      timer_label TEXT,
      timer_duration INTEGER,
      timer_started_at INTEGER,
      timer_elapsed_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chamber_members (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seat INTEGER,
      PRIMARY KEY (chamber_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS legislation (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill','resolution')),
      author TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      docket_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','debating','passed','failed','tabled')),
      vote_yes INTEGER, vote_no INTEGER, vote_abstain INTEGER
    );
    CREATE TABLE IF NOT EXISTS speeches (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
      speaker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('authorship','sponsorship','aff','neg')),
      recognized_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_seconds INTEGER
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      speech_id INTEGER NOT NULL REFERENCES speeches(id) ON DELETE CASCADE,
      questioner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS speech_requests (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('aff','neg','question')),
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (chamber_id, user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS motions (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      legislation_id INTEGER,
      kind TEXT NOT NULL,
      mover_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','voting','passed','failed','withdrawn')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vote_rounds (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('legislation','motion')),
      target_id INTEGER NOT NULL,
      threshold TEXT NOT NULL DEFAULT 'majority' CHECK (threshold IN ('majority','two_thirds')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      result TEXT,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ballots (
      vote_round_id INTEGER NOT NULL REFERENCES vote_rounds(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      choice TEXT NOT NULL CHECK (choice IN ('yes','no','abstain')),
      PRIMARY KEY (vote_round_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS speech_scores (
      speech_id INTEGER NOT NULL REFERENCES speeches(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (speech_id, judge_id)
    );
    CREATE TABLE IF NOT EXISTS po_scores (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      po_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chamber_id, judge_id, po_user_id)
    );
    CREATE TABLE IF NOT EXISTS rankings (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      PRIMARY KEY (chamber_id, judge_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY,
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trackers (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS judge_ballots (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      submitted_at INTEGER,
      publish TEXT NOT NULL DEFAULT 'private' CHECK (publish IN ('private','individual','all')),
      PRIMARY KEY (chamber_id, judge_id)
    );
    CREATE TABLE IF NOT EXISTS practice_scores (
      speech_id INTEGER NOT NULL REFERENCES speeches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (speech_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS practice_rankings (
      chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ranked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      PRIMARY KEY (chamber_id, user_id, ranked_user_id)
    );
  `);
  migrate(db);
  return db;
}

// Add columns introduced after the first release, so existing databases keep working.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
  const add = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('chamber_members', 'speak_pos', 'REAL');      // speaking precedence queue (null = recompute from the record)
  add('chamber_members', 'question_pos', 'REAL');   // questioning precedence queue
  add('chambers', 'is_mock', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'mock_chamber_id', 'INTEGER');       // set for made-up people in a mock tournament
  add('chambers', 'standings_publish', "TEXT NOT NULL DEFAULT 'private'"); // private | individual | all
}

module.exports = { open, DB_PATH };
