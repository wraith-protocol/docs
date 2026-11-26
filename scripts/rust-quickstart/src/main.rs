use anyhow::{Context, Result};
use ed25519_dalek::SigningKey;
use stellar_strkey::ed25519::PrivateKey;
use wraith_rust_quickstart::{generate, Recipient};

fn main() -> Result<()> {
    let seed: PrivateKey = std::env::var("STELLAR_SECRET")
        .map_err(|_| anyhow::anyhow!("provide a disposable test seed through STELLAR_SECRET"))?
        .parse()
        .context("invalid Stellar secret seed")?;
    let recipient = Recipient::derive(&SigningKey::from_bytes(&seed.0));
    let (spending, viewing) = recipient.public_keys();
    let announcement = generate(&spending, &viewing)?;
    anyhow::ensure!(recipient.matches(&announcement)?, "address did not match");
    println!("Matched one announcement for {}", announcement.address);
    Ok(())
}
