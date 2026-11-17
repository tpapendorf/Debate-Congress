'use strict';
const { open, DB_PATH } = require('./db');
const { createApp } = require('./app');

const db = open();
const app = createApp(db, { dbFile: DB_PATH });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Congress app listening on http://localhost:${port}`));
