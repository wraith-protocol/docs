use serde_json::Value;
use std::process::Command;

#[test]
fn binary_with_injected_fixture_emits_only_a_public_address() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../python-quickstart/vectors.json")).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_wraith-rust-quickstart"))
        .env(
            "STELLAR_SECRET",
            fixture["owner"]["secret"].as_str().unwrap(),
        )
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let text = std::str::from_utf8(&output.stdout).unwrap().trim_end();
    let address = text.strip_prefix("Matched one announcement for ").unwrap();
    assert!(address
        .parse::<stellar_strkey::ed25519::PublicKey>()
        .is_ok());
}
