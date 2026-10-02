use disk_clean::{clean, review, scan};
use std::process::ExitCode;

const USAGE: &str =
    "usage: disk-clean scan [RUN_DIR] | review [RUN_DIR] | clean [--dry-run] RUN_DIR";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).cloned();
    let result = match args.first().map(String::as_str) {
        Some("scan") => scan::run(arg(1)),
        Some("review") => review::run(arg(1)),
        Some("clean") if arg(1).as_deref() == Some("--worker") => {
            clean::worker(&arg(2).unwrap_or_default())
        }
        Some("clean") if arg(1).as_deref() == Some("--dry-run") => {
            clean::queue(&arg(2).unwrap_or_default(), true)
        }
        Some("clean") => clean::queue(&arg(1).unwrap_or_default(), false),
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
