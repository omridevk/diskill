use clean_disk::scan::parse_docker_bytes;

#[test]
fn docker_reclaimable_parses_like_the_python_regex() {
    let cases = [
        ("1.2GB (40%)", (1.2f64 * 1073741824.0) as u64),
        ("512MB", 512 * 1048576),
        ("3.5 GB", (3.5f64 * 1073741824.0) as u64),
        ("0B (0%)", 0),
        ("120B", 120),
        ("12.5kB", 0),
        ("2TB", 2 * 1099511627776),
        ("", 0),
        ("n/a", 0),
        ("1.2.3GB", 0),
    ];
    for (input, want) in cases {
        assert_eq!(parse_docker_bytes(input), want, "{input:?}");
    }
}
