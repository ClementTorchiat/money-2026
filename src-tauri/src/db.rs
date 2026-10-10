use rusqlite::{Connection, Result};
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
}

pub fn init_db(db_path: &str) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    
    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])?;
    
    // Create tables
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            initial_balance REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id INTEGER,
            type TEXT NOT NULL,
            FOREIGN KEY (parent_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS payees (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            last_category_id INTEGER,
            last_amount REAL,
            FOREIGN KEY (last_category_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            payee_id INTEGER,
            category_id INTEGER,
            check_number TEXT,
            memo TEXT,
            amount REAL NOT NULL,
            status TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (payee_id) REFERENCES payees(id),
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS scheduled_transactions (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL,
            payee_id INTEGER,
            category_id INTEGER,
            amount REAL NOT NULL,
            frequency TEXT NOT NULL,
            next_due_date TEXT NOT NULL,
            is_active BOOLEAN DEFAULT 1,
            FOREIGN KEY (account_id) REFERENCES accounts(id),
            FOREIGN KEY (payee_id) REFERENCES payees(id),
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );
    ")?;

    // Try to add the check_number column if it doesn't exist
    let _ = conn.execute("ALTER TABLE transactions ADD COLUMN check_number TEXT;", []);

    // Insert dummy data for UI testing
    let account_count: i64 = conn.query_row("SELECT count(*) FROM accounts", [], |row| row.get(0))?;
    if account_count == 0 {
        conn.execute("INSERT INTO accounts (name, type, initial_balance) VALUES ('Compte Courant', 'CHECKING', 0)", [])?;
        conn.execute("INSERT INTO categories (name, type) VALUES ('Alimentation', 'EXPENSE')", [])?;
        conn.execute("INSERT INTO categories (name, type) VALUES ('Logement', 'EXPENSE')", [])?;
        conn.execute("INSERT INTO payees (name, last_category_id, last_amount) VALUES ('Boulangerie', 1, -1.20)", [])?;
        conn.execute("INSERT INTO payees (name, last_category_id, last_amount) VALUES ('EDF', 2, -80.00)", [])?;
        conn.execute("INSERT INTO transactions (account_id, date, payee_id, category_id, memo, amount, status) VALUES (1, '2026-10-09', 1, 1, 'Croissants', -4.50, NULL)", [])?;
        
        // Dummy scheduled transaction
        conn.execute("INSERT INTO scheduled_transactions (account_id, payee_id, category_id, amount, frequency, next_due_date) VALUES (1, 2, 2, -80.00, 'MONTHLY', '2026-10-10')", [])?;
    }

    Ok(conn)
}
