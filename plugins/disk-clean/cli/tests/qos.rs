mod common;

use disk_clean::scan::{self, Sink};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;

fn qos() -> u32 {
    let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
    let mut relative = 0;
    // SAFETY: pthread_get_qos_class_np writes only into the two locals passed to it.
    unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative) };
    class as u32
}

struct Threads(Mutex<Vec<(ThreadId, u32)>>);

impl Sink for Threads {
    fn emit(&self, _: &str, _: Value) {
        let mut seen = self.0.lock().unwrap();
        seen.push((std::thread::current().id(), qos()));
    }
}

#[test]
fn every_scan_thread_that_reports_runs_at_utility_qos() {
    let t = common::temp_dir("scan-qos");
    let home = t.0.join("home");
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q app && cd app && git commit -q --allow-empty -m x && git worktree add -q ../app-wt",
    );
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    // SAFETY: this test binary holds this one test, so no other thread reads the environment.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("DISK_CLEAN_SKIP_MAP", "1");
        std::env::set_var("DISK_CLEAN_MIN_BYTES", "1");
    }
    let utility = libc::qos_class_t::QOS_CLASS_UTILITY as u32;
    assert_ne!(
        qos(),
        utility,
        "the test thread starts at its default class"
    );
    let sink = Threads(Mutex::new(Vec::new()));
    std::thread::scope(|s| {
        s.spawn(|| scan::scan(&run, &sink, Arc::new(AtomicBool::new(false))).unwrap());
    });
    let seen = sink.0.into_inner().unwrap();
    let threads: HashSet<ThreadId> = seen.iter().map(|(id, _)| *id).collect();
    assert!(
        threads.len() >= 2,
        "events came from the worktree checks too: {seen:?}"
    );
    assert!(seen.iter().all(|(_, class)| *class == utility), "{seen:?}");
}
