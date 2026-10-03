use disk_clean::{clean, hold, review, scan, util, watch};
use std::process::ExitCode;

const USAGE: &str = "usage: disk-clean scan [RUN_DIR] | review [RUN_DIR] | clean [--dry-run] RUN_DIR | undo RUN_DIR | free RUN_DIR";

fn announce_home() -> Result<(), String> {
    let home = util::checked_home()?;
    let raw = std::env::var("HOME").unwrap_or_default();
    if raw != home {
        eprintln!("disk-clean: HOME {raw} resolves to {home}, using {home}");
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).cloned();
    let commands = ["scan", "review", "watch", "clean", "undo", "free"];
    if args.first().is_some_and(|a| commands.contains(&a.as_str())) {
        if let Err(e) = announce_home() {
            eprintln!("disk-clean: {e}");
            return ExitCode::from(1);
        }
        hold::expire(&util::home());
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
        Some("undo") => hold::run_undo(arg(1)),
        Some("free") => hold::run_free(arg(1)),
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
