use rusqlite::Connection;
fn main() {
    let mut conn = Connection::open("/Users/clementtorchiat/Library/Application Support/com.money2026.app/money2026.db").unwrap();
    let tx = conn.transaction().unwrap();
    
    let mut stmt = tx.prepare("SELECT id, account_id, payee_id, category_id, amount, frequency, next_due_date FROM scheduled_transactions WHERE next_due_date <= date('now', 'localtime')").unwrap();
    
    let due_schedules: Vec<(i64, i64, i64, i64, f64, String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
    }).unwrap().filter_map(Result::ok).collect();
    
    println!("{:?}", due_schedules);
    
    for (schedule_id, account_id, payee_id, category_id, amount, frequency, next_due_date) in due_schedules {
        let modifier = "+1 month";
        let mut current_date = next_due_date.clone();
        
        let is_past_or_today: bool = tx.query_row(
            "SELECT date(?1) <= date('now', 'localtime')",
            [&current_date],
            |row| row.get(0)
        ).unwrap();
        
        println!("is_past_or_today: {}", is_past_or_today);
    }
}
