use gathering::db::Db;

use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let mut data_dir: Option<String> = None;
    let mut json_output = false;
    let mut cmd_args: Vec<String> = Vec::new();
    let mut show_help = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--data" | "-d" => {
                i += 1;
                if i < args.len() {
                    data_dir = Some(args[i].clone());
                } else {
                    eprintln!("Error: --data requires a path argument");
                    std::process::exit(1);
                }
            }
            "--json" | "-j" => json_output = true,
            "--help" | "-h" => show_help = true,
            _ => cmd_args.push(args[i].clone()),
        }
        i += 1;
    }

    if show_help {
        print_usage();
        return;
    }

    let data_path = data_dir
        .or_else(|| std::env::var("GATHERING_DATA").ok())
        .unwrap_or_else(|| "gathering-data".to_string());
    let data_path = PathBuf::from(&data_path);

    let db_path = data_path.join("gathering.db");
    if !db_path.exists() {
        eprintln!("Error: database not found at {}", db_path.display());
        eprintln!("Use --data <path> or set GATHERING_DATA to specify the data directory.");
        std::process::exit(1);
    }

    let db = match Db::open(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Error: failed to open database: {}", e);
            std::process::exit(1);
        }
    };

    if cmd_args.is_empty() {
        interactive_mode(&db, &data_path, &db_path);
    } else {
        let exit_code = run_command(&db, &data_path, &cmd_args, json_output);
        std::process::exit(exit_code);
    }
}

// ── Command dispatch ────────────────────────────────────────────────

fn run_command(db: &Db, data_path: &Path, args: &[String], json: bool) -> i32 {
    if args.is_empty() { return 1; }
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");

    match args[0].as_str() {
        "users" => cmd_users(db, data_path, sub, &args[1..], json),
        "channels" => cmd_channels(db, sub, &args[1..], json),
        "roles" => cmd_roles(db, sub, &args[1..], json),
        "settings" => cmd_settings(db, data_path, sub, &args[1..], json),
        "invites" => cmd_invites(db, sub, &args[1..], json),
        "files" => cmd_files(db, data_path, sub, &args[1..], json),
        "db" => cmd_db(db, data_path, sub, &args[1..], json),
        _ => {
            eprintln!("Unknown command: {}", args[0]);
            eprintln!("Run with --help for usage.");
            1
        }
    }
}

// ── Users ───────────────────────────────────────────────────────────

fn cmd_users(db: &Db, data_path: &Path, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let users = db.list_users();
            if json {
                let items: Vec<serde_json::Value> = users.iter().map(|(u, created)| {
                    let roles = db.get_user_roles(u);
                    serde_json::json!({"username": u, "created_at": created, "roles": roles})
                }).collect();
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            } else {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for (u, created) in &users {
                    let roles = db.get_user_roles(u);
                    rows.push(vec![u.clone(), roles.join(", "), created.clone()]);
                }
                print_table(&["Username", "Roles", "Created"], &rows);
                println!("\n{} user(s)", users.len());
            }
            0
        }
        "info" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users info <username>"); return 1; }
            };
            if !db.user_exists(username) {
                eprintln!("Error: user '{}' not found", username);
                return 1;
            }
            let roles = db.get_user_roles(username);
            let perms = db.get_user_permissions(username);
            let sessions = db.count_user_sessions(username);
            let disk_usage = db.get_user_disk_usage(username);
            let quota = db.get_user_quota(username);
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "username": username,
                    "roles": roles,
                    "permissions": perms,
                    "active_sessions": sessions,
                    "disk_usage_bytes": disk_usage,
                    "disk_quota_bytes": quota,
                })).unwrap());
            } else {
                println!("Username:    {}", username);
                println!("Roles:       {}", if roles.is_empty() { "(none)".into() } else { roles.join(", ") });
                println!("Permissions: {}", if perms.is_empty() { "(none)".into() } else { perms.join(", ") });
                println!("Sessions:    {} active", sessions);
                println!("Disk usage:  {}", format_bytes(disk_usage));
                if quota > 0 {
                    println!("Disk quota:  {}", format_bytes(quota));
                } else {
                    println!("Disk quota:  unlimited");
                }
            }
            0
        }
        "create" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users create <username> <password>"); return 1; }
            };
            let password = match args.get(2) {
                Some(p) => p,
                None => { eprintln!("Usage: users create <username> <password>"); return 1; }
            };
            match db.register(username, password) {
                Ok(()) => {
                    let _ = db.assign_role(username, "user");
                    println!("Created user '{}'", username);
                    0
                }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "delete" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users delete <username> [--purge]"); return 1; }
            };
            let purge = args.iter().any(|a| a == "--purge");
            if !db.user_exists(username) {
                eprintln!("Error: user '{}' not found", username);
                return 1;
            }
            // Also remove their uploaded files from disk
            let user_files = db.list_all_files(Some(username), None);
            match db.delete_user(username, purge) {
                Ok(()) => {
                    // Clean up disk files
                    let uploads_dir = data_path.join("uploads");
                    let mut cleaned = 0usize;
                    for (id, filename, _, _, _, _) in &user_files {
                        let ext = Path::new(filename).extension().and_then(|e| e.to_str()).unwrap_or("bin");
                        let disk_name = format!("{}.{}", id, ext);
                        let fpath = uploads_dir.join(&disk_name);
                        if std::fs::remove_file(&fpath).is_ok() {
                            cleaned += 1;
                        }
                    }
                    if purge {
                        println!("Deleted user '{}' and purged their messages/topics", username);
                    } else {
                        println!("Deleted user '{}' (messages preserved)", username);
                    }
                    if cleaned > 0 {
                        println!("Removed {} file(s) from disk", cleaned);
                    }
                    0
                }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "reset-password" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users reset-password <username> <password>"); return 1; }
            };
            let password = match args.get(2) {
                Some(p) => p,
                None => { eprintln!("Usage: users reset-password <username> <password>"); return 1; }
            };
            match db.reset_password(username, password) {
                Ok(()) => { println!("Password reset for '{}'. All sessions invalidated.", username); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "set-role" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users set-role <username> <role>"); return 1; }
            };
            let role = match args.get(2) {
                Some(r) => r,
                None => { eprintln!("Usage: users set-role <username> <role>"); return 1; }
            };
            if !db.user_exists(username) {
                eprintln!("Error: user '{}' not found", username);
                return 1;
            }
            match db.assign_role(username, role) {
                Ok(()) => { println!("Assigned role '{}' to '{}'", role, username); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "remove-role" => {
            let username = match args.get(1) {
                Some(u) => u,
                None => { eprintln!("Usage: users remove-role <username> <role>"); return 1; }
            };
            let role = match args.get(2) {
                Some(r) => r,
                None => { eprintln!("Usage: users remove-role <username> <role>"); return 1; }
            };
            match db.remove_role(username, role) {
                Ok(()) => { println!("Removed role '{}' from '{}'", role, username); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        _ => {
            eprintln!("Unknown users subcommand: '{}'", sub);
            eprintln!("Available: list, info, create, delete, reset-password, set-role, remove-role");
            1
        }
    }
}

// ── Channels ────────────────────────────────────────────────────────

fn cmd_channels(db: &Db, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let channels = db.list_channels_full();
            if json {
                let items: Vec<serde_json::Value> = channels.iter().map(|(name, ctype, restricted, creator, msgs)| {
                    serde_json::json!({
                        "name": name, "type": ctype, "restricted": restricted,
                        "created_by": creator, "messages": msgs,
                    })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            } else {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for (name, ctype, restricted, creator, msgs) in &channels {
                    let flags = if *restricted { "restricted" } else { "open" };
                    rows.push(vec![
                        name.clone(), ctype.clone(), flags.to_string(),
                        creator.clone().unwrap_or_default(), msgs.to_string(),
                    ]);
                }
                print_table(&["Channel", "Type", "Access", "Creator", "Messages"], &rows);
                println!("\n{} channel(s)", channels.len());
            }
            0
        }
        "delete" => {
            let name = match args.get(1) {
                Some(n) => n,
                None => { eprintln!("Usage: channels delete <name>"); return 1; }
            };
            match db.delete_channel(name) {
                Ok(()) => { println!("Deleted channel '{}' and all contents", name); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "clear" => {
            let name = match args.get(1) {
                Some(n) => n,
                None => { eprintln!("Usage: channels clear <name>"); return 1; }
            };
            match db.clear_channel_messages(name) {
                Ok(count) => { println!("Deleted {} message(s) from '{}'", count, name); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "create" => {
            let name = match args.get(1) {
                Some(n) => n,
                None => { eprintln!("Usage: channels create <name> [--type text|voice|topic]"); return 1; }
            };
            let mut ctype = "text";
            let mut k = 2;
            while k < args.len() {
                if args[k] == "--type" {
                    k += 1;
                    if k < args.len() { ctype = &args[k]; }
                }
                k += 1;
            }
            if db.channel_exists(name) {
                eprintln!("Error: channel '{}' already exists", name);
                return 1;
            }
            db.create_channel_with_type(name, ctype);
            println!("Created {} channel '{}'", ctype, name);
            0
        }
        _ => {
            eprintln!("Unknown channels subcommand: '{}'", sub);
            eprintln!("Available: list, delete, clear, create");
            1
        }
    }
}

// ── Roles ───────────────────────────────────────────────────────────

fn cmd_roles(db: &Db, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let roles = db.list_roles();
            if json {
                let items: Vec<serde_json::Value> = roles.iter().map(|r| {
                    serde_json::json!({
                        "name": r.name, "permissions": r.permissions,
                        "disk_quota_mb": r.disk_quota_mb,
                    })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            } else {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for r in &roles {
                    rows.push(vec![
                        r.name.clone(),
                        r.permissions.join(", "),
                        if r.disk_quota_mb > 0 { format!("{} MB", r.disk_quota_mb) } else { "unlimited".into() },
                    ]);
                }
                print_table(&["Role", "Permissions", "Disk Quota"], &rows);
            }
            0
        }
        "create" => {
            let name = match args.get(1) {
                Some(n) => n,
                None => { eprintln!("Usage: roles create <name> <perm1,perm2,...>"); return 1; }
            };
            let perms_str = match args.get(2) {
                Some(p) => p,
                None => { eprintln!("Usage: roles create <name> <perm1,perm2,...>"); return 1; }
            };
            let permissions: Vec<String> = perms_str.split(',').map(|s| s.trim().to_string()).collect();
            db.upsert_role(name, &permissions);
            println!("Created/updated role '{}' with permissions: {}", name, perms_str);
            0
        }
        "delete" => {
            let name = match args.get(1) {
                Some(n) => n,
                None => { eprintln!("Usage: roles delete <name>"); return 1; }
            };
            match db.delete_role(name) {
                Ok(()) => { println!("Deleted role '{}'", name); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        _ => {
            eprintln!("Unknown roles subcommand: '{}'", sub);
            eprintln!("Available: list, create, delete");
            1
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────

fn cmd_settings(db: &Db, data_path: &Path, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let settings = db.get_settings();
            if json {
                println!("{}", serde_json::to_string_pretty(&settings).unwrap());
            } else {
                let mut sorted: Vec<_> = settings.iter().collect();
                sorted.sort_by_key(|(k, _)| (*k).clone());
                let rows: Vec<Vec<String>> = sorted.iter().map(|(k, v)| vec![k.to_string(), v.to_string()]).collect();
                print_table(&["Key", "Value"], &rows);
            }
            0
        }
        "set" => {
            let key = match args.get(1) {
                Some(k) => k,
                None => { eprintln!("Usage: settings set <key> <value>"); return 1; }
            };
            let value = match args.get(2) {
                Some(v) => v,
                None => { eprintln!("Usage: settings set <key> <value>"); return 1; }
            };
            match db.set_setting(key, value) {
                Ok(()) => {
                    println!("Set {} = {}", key, value);
                    sync_setting_to_config(data_path, key, value);
                    0
                }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        _ => {
            eprintln!("Unknown settings subcommand: '{}'", sub);
            eprintln!("Available: list, set");
            1
        }
    }
}

// ── Invites ─────────────────────────────────────────────────────────

fn cmd_invites(db: &Db, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let invites = db.list_invites();
            if json {
                let items: Vec<serde_json::Value> = invites.iter().map(|inv| {
                    serde_json::json!({
                        "code": inv.code, "created_by": inv.created_by,
                        "created_at": inv.created_at,
                        "used_by": inv.used_by, "used_at": inv.used_at,
                    })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            } else {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for inv in &invites {
                    let status = if inv.used_by.is_some() { "used" } else { "available" };
                    rows.push(vec![
                        inv.code.clone(), inv.created_by.clone(),
                        inv.created_at.clone(), status.to_string(),
                    ]);
                }
                print_table(&["Code", "Created By", "Created At", "Status"], &rows);
                println!("\n{} invite(s)", invites.len());
            }
            0
        }
        "create" => {
            let creator = args.get(1).map(|s| s.as_str()).unwrap_or("admin");
            let code = db.create_invite(creator);
            if json {
                println!("{}", serde_json::json!({"code": code}));
            } else {
                println!("Created invite code: {}", code);
            }
            0
        }
        "purge-used" => {
            let count = db.purge_used_invites();
            println!("Purged {} used invite(s)", count);
            0
        }
        _ => {
            eprintln!("Unknown invites subcommand: '{}'", sub);
            eprintln!("Available: list, create, purge-used");
            1
        }
    }
}

// ── Files ───────────────────────────────────────────────────────────

fn cmd_files(db: &Db, data_path: &Path, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "list" => {
            let mut user_filter: Option<&str> = None;
            let mut channel_filter: Option<&str> = None;
            let mut k = 1;
            while k < args.len() {
                match args[k].as_str() {
                    "--user" => { k += 1; if k < args.len() { user_filter = Some(&args[k]); } }
                    "--channel" => { k += 1; if k < args.len() { channel_filter = Some(&args[k]); } }
                    _ => {}
                }
                k += 1;
            }
            let files = db.list_all_files(user_filter, channel_filter);
            if json {
                let items: Vec<serde_json::Value> = files.iter().map(|(id, name, size, uploader, channel, created)| {
                    serde_json::json!({
                        "id": id, "filename": name, "size": size,
                        "uploader": uploader, "channel": channel, "created_at": created,
                    })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            } else {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for (id, name, size, uploader, channel, created) in &files {
                    rows.push(vec![
                        short_id(id), name.clone(), format_bytes(*size),
                        uploader.clone(), channel.clone(), created.clone(),
                    ]);
                }
                print_table(&["ID", "Filename", "Size", "Uploader", "Channel", "Created"], &rows);
                println!("\n{} file(s)", files.len());
            }
            0
        }
        "stats" => {
            let (count, total_size) = db.file_stats();
            if json {
                println!("{}", serde_json::json!({"count": count, "total_size_bytes": total_size}));
            } else {
                println!("Files: {}", count);
                println!("Total size: {}", format_bytes(total_size));
            }
            0
        }
        "delete" => {
            let file_id = match args.get(1) {
                Some(id) => id,
                None => { eprintln!("Usage: files delete <id>"); return 1; }
            };
            match db.delete_file_record(file_id) {
                Some((id, filename)) => {
                    let ext = Path::new(&filename).extension().and_then(|e| e.to_str()).unwrap_or("bin");
                    let disk_name = format!("{}.{}", id, ext);
                    let fpath = data_path.join("uploads").join(&disk_name);
                    if std::fs::remove_file(&fpath).is_ok() {
                        println!("Deleted file '{}' (DB record + disk file)", file_id);
                    } else {
                        println!("Deleted file '{}' (DB record only, disk file not found)", file_id);
                    }
                    0
                }
                None => { eprintln!("Error: file '{}' not found", file_id); 1 }
            }
        }
        "orphans" => {
            let uploads_dir = data_path.join("uploads");
            let db_files = db.list_all_files(None, None);
            let db_ids: std::collections::HashSet<String> = db_files.iter().map(|(id, _, _, _, _, _)| id.clone()).collect();

            // Check disk files not in DB
            let mut disk_orphans: Vec<String> = Vec::new();
            let mut db_orphans: Vec<String> = Vec::new();

            if let Ok(entries) = std::fs::read_dir(&uploads_dir) {
                let disk_files: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|ft| ft.is_file()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();

                let disk_ids: std::collections::HashSet<String> = disk_files.iter()
                    .map(|name| name.split('.').next().unwrap_or("").to_string())
                    .collect();

                for disk_name in &disk_files {
                    let id = disk_name.split('.').next().unwrap_or("");
                    if !id.is_empty() && !db_ids.contains(id) {
                        disk_orphans.push(disk_name.clone());
                    }
                }

                for (id, _, _, _, _, _) in &db_files {
                    if !disk_ids.contains(id) {
                        db_orphans.push(id.clone());
                    }
                }
            }

            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "disk_only": disk_orphans,
                    "db_only": db_orphans,
                })).unwrap());
            } else {
                if disk_orphans.is_empty() && db_orphans.is_empty() {
                    println!("No orphans found. DB and disk are in sync.");
                } else {
                    if !disk_orphans.is_empty() {
                        println!("Files on disk with no DB record ({}):", disk_orphans.len());
                        for f in &disk_orphans {
                            println!("  {}", f);
                        }
                    }
                    if !db_orphans.is_empty() {
                        println!("DB records with no disk file ({}):", db_orphans.len());
                        for id in &db_orphans {
                            println!("  {}", id);
                        }
                    }
                }
            }
            0
        }
        _ => {
            eprintln!("Unknown files subcommand: '{}'", sub);
            eprintln!("Available: list, stats, delete, orphans");
            1
        }
    }
}

// ── DB commands ─────────────────────────────────────────────────────

fn cmd_db(db: &Db, data_path: &Path, sub: &str, args: &[String], json: bool) -> i32 {
    match sub {
        "stats" => {
            let counts = db.table_counts();
            let db_path = data_path.join("gathering.db");
            let db_size = std::fs::metadata(&db_path).map(|m| m.len() as i64).unwrap_or(0);
            if json {
                let mut map: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
                for (table, count) in &counts {
                    map.insert(table.clone(), serde_json::json!(count));
                }
                map.insert("_db_size_bytes".into(), serde_json::json!(db_size));
                println!("{}", serde_json::to_string_pretty(&serde_json::Value::Object(map)).unwrap());
            } else {
                println!("Database: {}", db_path.display());
                println!("Size: {}\n", format_bytes(db_size));
                let rows: Vec<Vec<String>> = counts.iter().map(|(t, c)| vec![t.clone(), c.to_string()]).collect();
                print_table(&["Table", "Rows"], &rows);
            }
            0
        }
        "backup" => {
            let output = args.get(1).map(|s| PathBuf::from(s))
                .unwrap_or_else(|| data_path.join("backups"));
            std::fs::create_dir_all(&output).ok();
            match db.backup(&output) {
                Ok(path) => { println!("Backup created: {}", path.display()); 0 }
                Err(e) => { eprintln!("Error: {}", e); 1 }
            }
        }
        "purge-expired" => {
            let n = db.purge_expired();
            println!("Purged {} expired message(s)/topic(s)", n);
            0
        }
        "purge-sessions" => {
            let n = db.purge_expired_sessions();
            println!("Purged {} expired session(s)", n);
            0
        }
        _ => {
            eprintln!("Unknown db subcommand: '{}'", sub);
            eprintln!("Available: stats, backup, purge-expired, purge-sessions");
            1
        }
    }
}

// ── Interactive mode ────────────────────────────────────────────────

fn interactive_mode(db: &Db, data_path: &Path, db_path: &Path) {
    println!("\nGathering Admin — {}\n", db_path.display());

    loop {
        println!(" 1) Users");
        println!(" 2) Channels");
        println!(" 3) Roles");
        println!(" 4) Settings");
        println!(" 5) Invites");
        println!(" 6) Files");
        println!(" 7) Database");
        println!(" q) Quit");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => interactive_users(db, data_path),
            "2" => interactive_channels(db),
            "3" => interactive_roles(db),
            "4" => interactive_settings(db, data_path),
            "5" => interactive_invites(db),
            "6" => interactive_files(db, data_path),
            "7" => interactive_db(db, data_path),
            "q" | "Q" | "quit" | "exit" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_users(db: &Db, data_path: &Path) {
    loop {
        println!("Users:");
        println!(" 1) List users");
        println!(" 2) User info");
        println!(" 3) Create user");
        println!(" 4) Delete user");
        println!(" 5) Reset password");
        println!(" 6) Assign role");
        println!(" 7) Remove role");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_users(db, data_path, "list", &["list".into()], false); println!(); }
            "2" => {
                let u = prompt("Username: ");
                if !u.is_empty() {
                    cmd_users(db, data_path, "info", &["info".into(), u], false);
                }
                println!();
            }
            "3" => {
                let u = prompt("Username: ");
                let p = prompt("Password: ");
                if !u.is_empty() && !p.is_empty() {
                    cmd_users(db, data_path, "create", &["create".into(), u, p], false);
                }
                println!();
            }
            "4" => {
                let u = prompt("Username: ");
                if !u.is_empty() {
                    let purge = prompt("Purge messages too? (y/N): ");
                    let confirm = prompt(&format!("Delete user '{}'? (y/N): ", u));
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        let mut args = vec!["delete".into(), u];
                        if purge.trim().eq_ignore_ascii_case("y") {
                            args.push("--purge".into());
                        }
                        cmd_users(db, data_path, "delete", &args, false);
                    } else {
                        println!("Cancelled.");
                    }
                }
                println!();
            }
            "5" => {
                let u = prompt("Username: ");
                let p = prompt("New password: ");
                if !u.is_empty() && !p.is_empty() {
                    cmd_users(db, data_path, "reset-password", &["reset-password".into(), u, p], false);
                }
                println!();
            }
            "6" => {
                let u = prompt("Username: ");
                let r = prompt("Role: ");
                if !u.is_empty() && !r.is_empty() {
                    cmd_users(db, data_path, "set-role", &["set-role".into(), u, r], false);
                }
                println!();
            }
            "7" => {
                let u = prompt("Username: ");
                let r = prompt("Role: ");
                if !u.is_empty() && !r.is_empty() {
                    cmd_users(db, data_path, "remove-role", &["remove-role".into(), u, r], false);
                }
                println!();
            }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_channels(db: &Db) {
    loop {
        println!("Channels:");
        println!(" 1) List channels");
        println!(" 2) Delete channel");
        println!(" 3) Clear messages");
        println!(" 4) Create channel");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_channels(db, "list", &["list".into()], false); println!(); }
            "2" => {
                let name = prompt("Channel name: ");
                if !name.is_empty() {
                    let confirm = prompt(&format!("Delete channel '{}' and all contents? (y/N): ", name));
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        cmd_channels(db, "delete", &["delete".into(), name], false);
                    } else {
                        println!("Cancelled.");
                    }
                }
                println!();
            }
            "3" => {
                let name = prompt("Channel name: ");
                if !name.is_empty() {
                    let confirm = prompt(&format!("Delete all messages in '{}'? (y/N): ", name));
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        cmd_channels(db, "clear", &["clear".into(), name], false);
                    } else {
                        println!("Cancelled.");
                    }
                }
                println!();
            }
            "4" => {
                let name = prompt("Channel name: ");
                if !name.is_empty() {
                    let ctype = prompt("Type (text/voice/topic) [text]: ");
                    let ctype = if ctype.trim().is_empty() { "text".to_string() } else { ctype };
                    cmd_channels(db, "create", &["create".into(), name, "--type".into(), ctype], false);
                }
                println!();
            }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_roles(db: &Db) {
    loop {
        println!("Roles:");
        println!(" 1) List roles");
        println!(" 2) Create/update role");
        println!(" 3) Delete role");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_roles(db, "list", &["list".into()], false); println!(); }
            "2" => {
                let name = prompt("Role name: ");
                let perms = prompt("Permissions (comma-separated): ");
                if !name.is_empty() && !perms.is_empty() {
                    cmd_roles(db, "create", &["create".into(), name, perms], false);
                }
                println!();
            }
            "3" => {
                let name = prompt("Role name: ");
                if !name.is_empty() {
                    let confirm = prompt(&format!("Delete role '{}'? (y/N): ", name));
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        cmd_roles(db, "delete", &["delete".into(), name], false);
                    } else {
                        println!("Cancelled.");
                    }
                }
                println!();
            }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_settings(db: &Db, data_path: &Path) {
    loop {
        println!("Settings:");
        println!(" 1) List settings");
        println!(" 2) Set a setting");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_settings(db, data_path, "list", &["list".into()], false); println!(); }
            "2" => {
                let key = prompt("Key: ");
                let value = prompt("Value: ");
                if !key.is_empty() && !value.is_empty() {
                    cmd_settings(db, data_path, "set", &["set".into(), key, value], false);
                }
                println!();
            }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_invites(db: &Db) {
    loop {
        println!("Invites:");
        println!(" 1) List invites");
        println!(" 2) Create invite");
        println!(" 3) Purge used invites");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_invites(db, "list", &["list".into()], false); println!(); }
            "2" => {
                let creator = prompt("Created by [admin]: ");
                let creator = if creator.trim().is_empty() { "admin".to_string() } else { creator };
                cmd_invites(db, "create", &["create".into(), creator], false);
                println!();
            }
            "3" => {
                let confirm = prompt("Purge all used invite codes? (y/N): ");
                if confirm.trim().eq_ignore_ascii_case("y") {
                    cmd_invites(db, "purge-used", &["purge-used".into()], false);
                } else {
                    println!("Cancelled.");
                }
                println!();
            }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_files(db: &Db, data_path: &Path) {
    loop {
        println!("Files:");
        println!(" 1) List files");
        println!(" 2) File stats");
        println!(" 3) Delete file");
        println!(" 4) Find orphans");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_files(db, data_path, "list", &["list".into()], false); println!(); }
            "2" => { cmd_files(db, data_path, "stats", &["stats".into()], false); println!(); }
            "3" => {
                let id = prompt("File ID: ");
                if !id.is_empty() {
                    let confirm = prompt(&format!("Delete file '{}'? (y/N): ", id));
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        cmd_files(db, data_path, "delete", &["delete".into(), id], false);
                    } else {
                        println!("Cancelled.");
                    }
                }
                println!();
            }
            "4" => { cmd_files(db, data_path, "orphans", &["orphans".into()], false); println!(); }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

fn interactive_db(db: &Db, data_path: &Path) {
    loop {
        println!("Database:");
        println!(" 1) Table stats");
        println!(" 2) Create backup");
        println!(" 3) Purge expired messages/topics");
        println!(" 4) Purge expired sessions");
        println!(" b) Back");
        print!("\n> ");

        let choice = read_line();
        println!();

        match choice.trim() {
            "1" => { cmd_db(db, data_path, "stats", &["stats".into()], false); println!(); }
            "2" => {
                let path = prompt(&format!("Backup directory [{}]: ", data_path.join("backups").display()));
                let args = if path.trim().is_empty() {
                    vec!["backup".into()]
                } else {
                    vec!["backup".into(), path]
                };
                cmd_db(db, data_path, "backup", &args, false);
                println!();
            }
            "3" => { cmd_db(db, data_path, "purge-expired", &["purge-expired".into()], false); println!(); }
            "4" => { cmd_db(db, data_path, "purge-sessions", &["purge-sessions".into()], false); println!(); }
            "b" | "B" | "back" => break,
            "" => {}
            _ => println!("Invalid choice.\n"),
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

fn print_table(headers: &[&str], rows: &[Vec<String>]) {
    if rows.is_empty() && headers.is_empty() { return; }

    let cols = headers.len();
    let mut widths = vec![0usize; cols];
    for (i, h) in headers.iter().enumerate() {
        widths[i] = h.len();
    }
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i < cols && cell.len() > widths[i] {
                widths[i] = cell.len();
            }
        }
    }

    // Header
    for (i, h) in headers.iter().enumerate() {
        if i > 0 { print!("  "); }
        print!("{:<width$}", h, width = widths[i]);
    }
    println!();

    // Separator
    for (i, w) in widths.iter().enumerate() {
        if i > 0 { print!("  "); }
        print!("{}", "-".repeat(*w));
    }
    println!();

    // Rows
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i >= cols { break; }
            if i > 0 { print!("  "); }
            print!("{:<width$}", cell, width = widths[i]);
        }
        println!();
    }
}

fn format_bytes(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn short_id(id: &str) -> String {
    if id.len() > 8 { format!("{}…", &id[..8]) } else { id.to_string() }
}

fn read_line() -> String {
    io::stdout().flush().ok();
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).ok();
    line.trim().to_string()
}

fn prompt(msg: &str) -> String {
    print!("{}", msg);
    read_line()
}

fn sync_setting_to_config(data_path: &Path, key: &str, value: &str) {
    let config_synced_keys = ["registration_mode", "channel_creation", "server_name", "server_icon"];
    if !config_synced_keys.contains(&key) {
        return;
    }

    let config_path = data_path.join("config.json");
    if !config_path.exists() {
        return;
    }

    let contents = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut config: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(obj) = config.as_object_mut() {
        obj.insert(key.to_string(), serde_json::Value::String(value.to_string()));
    }

    if let Ok(pretty) = serde_json::to_string_pretty(&config) {
        if std::fs::write(&config_path, pretty).is_ok() {
            println!("  (synced to config.json — restart server to apply)");
        }
    }
}

fn print_usage() {
    println!("gathering-admin — Gathering server administration tool

Usage: gathering-admin [OPTIONS] [COMMAND]

Options:
  --data, -d <path>  Data directory (default: gathering-data, or GATHERING_DATA env)
  --json, -j         Output in JSON format
  --help, -h         Show this help

When run with no command, enters interactive mode.

Commands:
  users list                              List all users with roles
  users info <username>                   Show user details
  users create <username> <password>      Create a user
  users delete <username> [--purge]       Delete user (--purge removes messages too)
  users reset-password <username> <pass>  Reset password, invalidate sessions
  users set-role <username> <role>        Assign a role
  users remove-role <username> <role>     Remove a role

  channels list                           List channels with type, message count
  channels delete <name>                  Delete channel and all contents
  channels clear <name>                   Delete all messages in a channel
  channels create <name> [--type <t>]     Create a channel (text/voice/topic)

  roles list                              List roles with permissions and quotas
  roles create <name> <perm1,perm2,...>   Create/update a role
  roles delete <name>                     Delete a role

  settings list                           Show all settings
  settings set <key> <value>              Set a setting

  invites list                            List invite codes
  invites create [creator]                Create an invite code
  invites purge-used                      Delete used invite codes

  files list [--user <u>] [--channel <c>] List files with optional filters
  files stats                             Show total file count and disk usage
  files delete <id>                       Delete file (DB + disk)
  files orphans                           Find DB/disk mismatches

  db stats                                Show table row counts and DB size
  db backup [<output-path>]               Create database backup
  db purge-expired                        Purge expired messages/topics
  db purge-sessions                       Delete expired sessions");
}
