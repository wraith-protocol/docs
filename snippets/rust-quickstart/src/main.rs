// src/main.rs
//
// Entry point for `cargo run`.  When the "network" feature is active the binary
// scans the Soroban testnet for stealth payments addressed to the keypair
// supplied via STELLAR_SECRET.  Without "network" it just derives keys and
// prints them — useful for local testing without an RPC call.

pub mod keypair;
pub mod network;
pub mod scan;
pub mod send;
pub mod stealth;

#[cfg(not(feature = "network"))]
fn main() -> anyhow::Result<()> {
    use ed25519_dalek::Signer;
    use network::STEALTH_SIGNING_MESSAGE;

    let secret = std::env::var("STELLAR_SECRET")?;
    let account = keypair::load_keypair(&secret)?;
    println!("loaded account: {}", account.address);

    // The 64-byte signature drives stealth key derivation.
    let sig: [u8; 64] = account
        .signing_key
        .sign(STEALTH_SIGNING_MESSAGE.as_bytes())
        .to_bytes();
    let keys = stealth::derive_stealth_keys(&sig);
    println!("spending pub : {}", hex::encode(keys.spending_pub));
    println!("viewing  pub : {}", hex::encode(keys.viewing_pub));
    Ok(())
}

#[cfg(feature = "network")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let secret = std::env::var("STELLAR_SECRET")?;
    scan::run_scan(&secret).await
}
