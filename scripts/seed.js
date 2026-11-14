'use strict';
// Creates a demo chamber with sample people and legislation so you can try every role.
// Usage: npm run seed   (refuses to run if the database already has users, unless --force)
const { open } = require('../server/db');
const { hashPassword } = require('../server/app');

const db = open();
const force = process.argv.includes('--force');
if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0 && !force) {
  console.error('The database already has users. Run with --force to add demo data anyway.');
  process.exit(1);
}

const PASSWORD = 'congress';
const hash = hashPassword(PASSWORD);
const addUser = db.prepare('INSERT OR IGNORE INTO users (username, display_name, school, role, password_hash) VALUES (?, ?, ?, ?, ?)');
const idOf = db.prepare('SELECT id FROM users WHERE username = ?');

const people = [
  ['admin', 'Parliamentarian', '', 'admin'],
  ['judge1', 'Judge Rivera', '', 'judge'],
  ['judge2', 'Judge Chen', '', 'judge'],
  ['avery', 'Avery Johnson', 'Lincoln HS', 'competitor'],
  ['blake', 'Blake Nguyen', 'Roosevelt HS', 'competitor'],
  ['casey', 'Casey Patel', 'Lincoln HS', 'competitor'],
  ['dana', 'Dana Morales', 'Garfield HS', 'competitor'],
  ['emery', 'Emery Brooks', 'Roosevelt HS', 'competitor'],
  ['finley', 'Finley Okafor', 'Garfield HS', 'competitor'],
  ['gray', 'Gray Thompson', 'Kennedy HS', 'competitor'],
  ['harper', 'Harper Liu', 'Kennedy HS', 'competitor'],
  ['indy', 'Indy Ramirez', 'Lincoln HS', 'competitor'],
  ['jules', 'Jules Andersen', 'Garfield HS', 'competitor'],
];
for (const [u, n, s, r] of people) addUser.run(u, n, s, r, hash);

const ch = db.prepare(`INSERT INTO chambers (name, score_min, score_max, rank_count) VALUES ('Demo House — Chamber A', 1, 6, 8)`).run();
const chamberId = Number(ch.lastInsertRowid);
const addMember = db.prepare('INSERT OR IGNORE INTO chamber_members (chamber_id, user_id, seat) VALUES (?, ?, ?)');
let seat = 0;
for (const [u, , , r] of people) {
  if (r === 'admin') continue;
  addMember.run(chamberId, idOf.get(u).id, r === 'competitor' ? ++seat : null);
}
db.prepare('UPDATE chambers SET po_user_id = ? WHERE id = ?').run(idOf.get('jules').id, chamberId);

const leg = [
  ['A Bill to Require Financial Literacy Instruction in Public High Schools', 'bill', 'Lincoln HS',
    'BE IT ENACTED BY THE CONGRESS HERE ASSEMBLED THAT:\nSECTION 1. All public high schools shall require one semester of personal finance instruction for graduation.\nSECTION 2. ...'],
  ['A Resolution to Rejoin the Trans-Pacific Partnership', 'resolution', 'Roosevelt HS',
    'WHEREAS, ...;\nRESOLVED, That the Congress here assembled urges the United States to seek membership in the CPTPP.'],
  ['A Bill to Fund High-Speed Rail in the Pacific Northwest', 'bill', 'Garfield HS', 'BE IT ENACTED...'],
];
const addLeg = db.prepare('INSERT INTO legislation (chamber_id, title, kind, author, body, docket_order) VALUES (?, ?, ?, ?, ?, ?)');
leg.forEach(([t, k, a, b], i) => addLeg.run(chamberId, t, k, a, b, i + 1));

console.log(`Demo chamber created (id ${chamberId}). Every demo account uses the password "${PASSWORD}".`);
console.log('  admin           admin / parliamentarian');
console.log('  judge1, judge2  judges');
console.log('  jules           presiding officer');
console.log('  avery … indy    competitors');
