// Creates all tables in D1. (The server also runs this automatically on every start.)
const repo = require('../src/db/repo');

repo
  .migrate()
  .then(() => {
    console.log('✅ D1 schema is up to date');
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  });
