use disk_clean::{clean, platform, review, scan, trash, util, watch};
use std::process::ExitCode;

const USAGE: &str = "usage: disk-clean scan [RUN_DIR] | review [RUN_DIR] | clean [--dry-run] RUN_DIR | undo RUN_DIR|--all | empty RUN_DIR|--all";

fn announce_home() -> Result<(), String> {
    let home = util::checked_home()?;
    let raw = platform::raw_home();
    if raw != home {
        eprintln!("disk-clean: HOME {raw} resolves to {home}, using {home}");
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).cloned();
    let commands = ["scan", "review", "watch", "clean", "undo", "empty"];
    if args.first().is_some_and(|a| commands.contains(&a.as_str())) {
        if let Err(e) = announce_home() {
            eprintln!("disk-clean: {e}");
            return ExitCode::from(1);
        }
        let home = util::home();
        trash::migrate(&home);
        let tells_the_page =
            args.first().is_some_and(|a| a == "watch") || arg(1).as_deref() == Some("--worker");
        if !tells_the_page && let Err(e) = trash::sync(&home) {
            eprintln!("disk-clean: could not check the Trash record: {e}");
        }
    }
    let result = match args.first().map(String::as_str) {
        Some("scan") => scan::run(arg(1)),
        Some("review") => review::run(arg(1)),
        Some("watch") => watch::run(arg(1)),
        Some("clean") if arg(1).as_deref() == Some("--worker") => {
            clean::worker(&arg(2).unwrap_or_default())
        }
        Some("clean") if arg(1).as_deref() == Some("--dry-run") => {
            clean::queue(&arg(2).unwrap_or_default(), true)
        }
        Some("clean") => clean::queue(&arg(1).unwrap_or_default(), false),
        Some("undo") => trash::run_undo(arg(1)),
        Some("empty") => trash::run_empty(arg(1)),
        _ => {
            eprintln!("{USAGE}");
            Ok(2)
        }
    };
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("disk-clean: {e}");
            ExitCode::from(1)
        }
    }
}
