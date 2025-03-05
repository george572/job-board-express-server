// dbSetup.js
const sqlite3 = require("sqlite3").verbose();

// Create a new SQLite database or open an existing one
const db = new sqlite3.Database("./database.db");
db.run("PRAGMA foreign_keys = ON;");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      name TEXT UNIQUE NOT NULL
      )
  `);
});
// Create the 'orders' table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      companyName TEXT NOT NULL,
      user_uid TEXT NOT NULL,
      jobName TEXT NOT NULL,
      jobSalary TEXT NOT NULL,
      jobDescription TEXT NOT NULL,
      jobExperienceRequired BOOLEAN,
      jobIsUrgent BOOLEAN,
      category_id INTEGER NOT NULL,  -- Foreign key reference to categories
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
    )
  `);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uid TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_type TEXT DEFAULT 'user',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      user_id TEXT,
      file_name TEXT,
      file_type TEXT,
      file_data BLOB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// db.serialize(() => {
//   db.run(`
// ALTER TABLE jobs ADD COLUMN company_email TEXT NOT NULL DEFAULT ''
//   `);
// });

// Export the db instance to be used in other files
module.exports = db;
