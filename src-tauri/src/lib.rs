mod db;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use std::sync::Mutex;
use db::AppState;

#[derive(Serialize)]
pub struct Account {
    id: i64,
    name: String,
    initial_balance: f64,
}

#[tauri::command]
fn get_account(state: State<AppState>, account_id: i64) -> Result<Account, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let account = conn.query_row(
        "SELECT id, name, initial_balance FROM accounts WHERE id = ?1",
        [account_id],
        |row| Ok(Account {
            id: row.get(0)?,
            name: row.get(1)?,
            initial_balance: row.get(2)?,
        })
    ).map_err(|e| e.to_string())?;
    
    Ok(account)
}

#[derive(Serialize)]
pub struct Transaction {
    id: i64,
    date: String,
    payee: String,
    category: String,
    check_number: Option<String>,
    amount: f64,
    status: Option<String>,
    #[serde(rename = "scheduleId")]
    schedule_id: Option<i64>,
}

#[tauri::command]
fn get_transactions(state: State<AppState>, account_id: i64) -> Result<Vec<Transaction>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare("
        SELECT t.id, t.date, p.name as payee, c.name as category, t.check_number, t.amount, t.status, t.schedule_id
        FROM transactions t
        LEFT JOIN payees p ON t.payee_id = p.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.account_id = ?
        ORDER BY t.date ASC, t.id ASC
    ").map_err(|e| e.to_string())?;

    let txs = stmt.query_map([account_id], |row| {
        Ok(Transaction {
            id: row.get(0)?,
            date: row.get(1)?,
            payee: row.get(2).unwrap_or_default(),
            category: row.get(3).unwrap_or_default(),
            check_number: row.get(4)?,
            amount: row.get(5)?,
            status: row.get(6)?,
            schedule_id: row.get(7)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for tx in txs {
        result.push(tx.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[derive(Deserialize)]
pub struct NewTransaction {
    account_id: i64,
    date: String,
    payee: String,
    category: String,
    check_number: Option<String>,
    amount: f64,
    status: Option<String>,
}

#[tauri::command]
fn add_transaction(state: State<AppState>, payload: NewTransaction) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?1, 'EXPENSE')", [&payload.category]).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO payees (name) VALUES (?1)", [&payload.payee]).map_err(|e| e.to_string())?;
    
    let cat_id: i64 = conn.query_row("SELECT id FROM categories WHERE name = ?1", [&payload.category], |row| row.get(0)).map_err(|e| e.to_string())?;
    let payee_id: i64 = conn.query_row("SELECT id FROM payees WHERE name = ?1", [&payload.payee], |row| row.get(0)).map_err(|e| e.to_string())?;

    // Update payee learning
    conn.execute(
        "UPDATE payees SET last_category_id = ?1, last_amount = ?2 WHERE id = ?3",
        (cat_id, payload.amount, payee_id),
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO transactions (account_id, date, payee_id, category_id, check_number, amount, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (payload.account_id, payload.date, payee_id, cat_id, payload.check_number, payload.amount, payload.status),
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_transaction(state: State<AppState>, tx_id: i64, payload: NewTransaction) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?1, 'EXPENSE')", [&payload.category]).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO payees (name) VALUES (?1)", [&payload.payee]).map_err(|e| e.to_string())?;
    
    let cat_id: i64 = conn.query_row("SELECT id FROM categories WHERE name = ?1", [&payload.category], |row| row.get(0)).map_err(|e| e.to_string())?;
    let payee_id: i64 = conn.query_row("SELECT id FROM payees WHERE name = ?1", [&payload.payee], |row| row.get(0)).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE payees SET last_category_id = ?1, last_amount = ?2 WHERE id = ?3",
        (cat_id, payload.amount, payee_id),
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE transactions SET date = ?1, payee_id = ?2, category_id = ?3, check_number = ?4, amount = ?5, status = ?6 WHERE id = ?7",
        (payload.date, payee_id, cat_id, payload.check_number, payload.amount, payload.status, tx_id),
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_transaction(state: State<AppState>, tx_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM transactions WHERE id = ?1", [tx_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_transactions_batch(state: State<AppState>, account_id: i64, transactions: Vec<NewTransaction>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for payload in transactions {
        tx.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?1, 'EXPENSE')", [&payload.category]).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO payees (name) VALUES (?1)", [&payload.payee]).map_err(|e| e.to_string())?;
        
        let cat_id: i64 = tx.query_row("SELECT id FROM categories WHERE name = ?1", [&payload.category], |row| row.get(0)).unwrap_or(1);
        let payee_id: i64 = tx.query_row("SELECT id FROM payees WHERE name = ?1", [&payload.payee], |row| row.get(0)).unwrap_or(1);

        // Update payee learning
        tx.execute(
            "UPDATE payees SET last_category_id = ?1, last_amount = ?2 WHERE id = ?3",
            (cat_id, payload.amount, payee_id),
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO transactions (account_id, date, payee_id, category_id, check_number, amount, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (account_id, payload.date, payee_id, cat_id, payload.check_number, payload.amount, payload.status),
        ).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_scheduled_transaction(state: State<AppState>, schedule_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE scheduled_transactions SET is_active = 0 WHERE id = ?1", [schedule_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_transaction_status(state: State<AppState>, tx_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let current_status: Option<String> = conn.query_row(
        "SELECT status FROM transactions WHERE id = ?1",
        [tx_id],
        |row| row.get(0)
    ).map_err(|e| e.to_string())?;

    let new_status = if current_status == Some("P".to_string()) {
        None::<String>
    } else {
        Some("P".to_string())
    };

    conn.execute(
        "UPDATE transactions SET status = ?1 WHERE id = ?2",
        rusqlite::params![new_status, tx_id]
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
pub struct PayeeSuggestion {
    name: String,
    category: Option<String>,
    amount: Option<f64>,
}

#[tauri::command]
fn search_payees(state: State<AppState>, query: String) -> Result<Vec<PayeeSuggestion>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare("
        SELECT p.name, c.name as category, p.last_amount 
        FROM payees p
        LEFT JOIN categories c ON p.last_category_id = c.id
        WHERE p.name LIKE ? || '%'
        ORDER BY p.name ASC
        LIMIT 5
    ").map_err(|e| e.to_string())?;

    let suggestions = stmt.query_map([query], |row| {
        Ok(PayeeSuggestion {
            name: row.get(0)?,
            category: row.get(1)?,
            amount: row.get(2)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for s in suggestions {
        result.push(s.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[derive(Serialize)]
pub struct ScheduledTransaction {
    id: i64,
    payee: String,
    category: String,
    amount: f64,
    frequency: String,
    next_due_date: String,
}

#[tauri::command]
fn get_scheduled_transactions(state: State<AppState>, account_id: i64) -> Result<Vec<ScheduledTransaction>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare("
        SELECT s.id, p.name as payee, c.name as category, s.amount, s.frequency, s.next_due_date 
        FROM scheduled_transactions s
        LEFT JOIN payees p ON s.payee_id = p.id
        LEFT JOIN categories c ON s.category_id = c.id
        WHERE s.account_id = ? AND s.is_active = 1
        ORDER BY s.next_due_date ASC
    ").map_err(|e| e.to_string())?;

    let txs = stmt.query_map([account_id], |row| {
        Ok(ScheduledTransaction {
            id: row.get(0)?,
            payee: row.get(1).unwrap_or_default(),
            category: row.get(2).unwrap_or_default(),
            amount: row.get(3)?,
            frequency: row.get(4)?,
            next_due_date: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for tx in txs {
        result.push(tx.map_err(|e| e.to_string())?);
    }
    Ok(result)
}


#[tauri::command]
fn process_due_scheduled_transactions(state: State<AppState>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    // We need to process schedules whose next_due_date is <= today (localtime)
    let mut stmt = tx.prepare("SELECT id, account_id, payee_id, category_id, amount, frequency, next_due_date FROM scheduled_transactions WHERE next_due_date <= date('now', 'localtime') AND is_active = 1").map_err(|e| e.to_string())?;
    
    let due_schedules: Vec<(i64, i64, i64, i64, f64, String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
    }).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    
    drop(stmt);

    for (schedule_id, account_id, payee_id, category_id, amount, frequency, next_due_date) in due_schedules {
        let modifier = match frequency.as_str() {
            "WEEKLY" => "+7 days",
            "YEARLY" => "+1 year",
            _ => "+1 month",
        };
        
        // Loop in case a schedule is multiple months behind
        let mut current_date = next_due_date.clone();
        let mut loop_count = 0;
        
        while loop_count < 100 { // safeguard
            // Check if current_date is <= today
            let is_past_or_today: i32 = tx.query_row(
                "SELECT date(?1) <= date('now', 'localtime')",
                [&current_date],
                |row| row.get(0)
            ).unwrap_or(0);
            
            if is_past_or_today == 0 {
                break;
            }
            
            // Insert the real transaction for this occurrence
            tx.execute(
                "INSERT INTO transactions (account_id, date, payee_id, category_id, check_number, amount, status, schedule_id) VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6)",
                (account_id, &current_date, payee_id, category_id, amount, schedule_id),
            ).map_err(|e| e.to_string())?;
            
            // Advance the date for the next iteration
            current_date = tx.query_row(
                &format!("SELECT date(?1, '{}')", modifier),
                [&current_date],
                |row| row.get(0)
            ).map_err(|e| e.to_string())?;
            
            loop_count += 1;
        }
        
        // Update the schedule's next_due_date to the first future date we computed
        tx.execute(
            "UPDATE scheduled_transactions SET next_due_date = ?1 WHERE id = ?2",
            (&current_date, schedule_id)
        ).map_err(|e| e.to_string())?;
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    
    Ok(())
}

#[derive(Deserialize)]
pub struct NewSchedule {
    account_id: i64,
    payee: String,
    category: String,
    amount: f64,
    frequency: String,
    next_due_date: String,
}

#[tauri::command]
fn add_scheduled_transaction(state: State<AppState>, payload: NewSchedule) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?1, 'EXPENSE')", [&payload.category]).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO payees (name) VALUES (?1)", [&payload.payee]).map_err(|e| e.to_string())?;
    
    let cat_id: i64 = conn.query_row("SELECT id FROM categories WHERE name = ?1", [&payload.category], |row| row.get(0)).map_err(|e| e.to_string())?;
    let payee_id: i64 = conn.query_row("SELECT id FROM payees WHERE name = ?1", [&payload.payee], |row| row.get(0)).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO scheduled_transactions (account_id, payee_id, category_id, amount, frequency, next_due_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (payload.account_id, payee_id, cat_id, payload.amount, payload.frequency, payload.next_due_date),
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_scheduled_transaction(state: State<AppState>, schedule_id: i64, payload: NewSchedule) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?1, 'EXPENSE')", [&payload.category]).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO payees (name) VALUES (?1)", [&payload.payee]).map_err(|e| e.to_string())?;
    
    let cat_id: i64 = conn.query_row("SELECT id FROM categories WHERE name = ?1", [&payload.category], |row| row.get(0)).map_err(|e| e.to_string())?;
    let payee_id: i64 = conn.query_row("SELECT id FROM payees WHERE name = ?1", [&payload.payee], |row| row.get(0)).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE scheduled_transactions SET account_id = ?1, payee_id = ?2, category_id = ?3, amount = ?4, frequency = ?5, next_due_date = ?6 WHERE id = ?7",
        (payload.account_id, payee_id, cat_id, payload.amount, payload.frequency, payload.next_due_date, schedule_id),
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn import_database(app_handle: tauri::AppHandle, state: State<AppState>, db_bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;

    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("money2026.db");

    // Lock the database so no one else uses it while we swap
    let mut conn_lock = state.db.lock().map_err(|e| e.to_string())?;
    
    // Overwrite the file
    let mut file = std::fs::File::create(&db_path).map_err(|e| e.to_string())?;
    file.write_all(&db_bytes).map_err(|e| e.to_string())?;
    
    // Re-initialize the db connection
    let new_conn = db::init_db(db_path.to_str().unwrap()).map_err(|e| e.to_string())?;
    
    // Replace the connection in the state
    *conn_lock = new_conn;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().unwrap();
            std::fs::create_dir_all(&app_data_dir).unwrap();
            let db_path = app_data_dir.join("money2026.db");
            
            let conn = db::init_db(db_path.to_str().unwrap()).unwrap();
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_account,
            get_transactions, 
            add_transaction,
            update_transaction,
            delete_transaction,
            import_transactions_batch,
            toggle_transaction_status,
            search_payees,
            get_scheduled_transactions,
            add_scheduled_transaction,
            update_scheduled_transaction,
            delete_scheduled_transaction,
            process_due_scheduled_transactions,
            import_database
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
