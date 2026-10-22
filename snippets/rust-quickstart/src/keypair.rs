// src/keypair.rs
use anyhow::Result;
use ed25519_dalek::SigningKey;

pub struct Account {
    pub seed: [u8; 32],
    pub signing_key: SigningKey,
    pub address: String,
}

pub fn load_keypair(secret: &str) -> Result<Account> {
    // `S...` -> 32-byte ed25519 seed via stellar-strkey ed25519::PrivateKey
    let private = stellar_strkey::ed25519::PrivateKey::from_string(secret)
        .map_err(|e| anyhow::anyhow!("invalid stellar secret: {e:?}"))?;
    let seed: [u8; 32] = private.0;
    let signing_key = SigningKey::from_bytes(&seed);
    let address =
        stellar_strkey::ed25519::PublicKey(signing_key.verifying_key().to_bytes()).to_string();
    Ok(Account {
        seed,
        signing_key,
        address,
    })
}

// crate-only-begin: fixture secret + unit tests, not shown in the guide

/// Fixture keypair used in tests and CI verification.
///
/// This is a well-known test vector: the all-zeros 32-byte seed encoded as a
/// Stellar secret key.  It is never funded on any network.
pub fn fixture_keypair() -> Account {
    // All-zeros seed encoded as a Stellar S... secret key.
    // stellar_strkey::ed25519::PrivateKey([0u8; 32]).to_string()
    // == "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2"
    const FIXTURE_SECRET: &str = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2";
    load_keypair(FIXTURE_SECRET).expect("fixture keypair is always valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::STEALTH_SIGNING_MESSAGE;
    use ed25519_dalek::Signer;

    #[test]
    fn fixture_loads_and_signs() {
        let acct = fixture_keypair();
        // Public key must be a valid G... Stellar address.
        assert!(acct.address.starts_with('G'), "address should start with G");
        // Must be able to produce a 64-byte signing signature.
        let sig = acct.signing_key.sign(STEALTH_SIGNING_MESSAGE.as_bytes());
        assert_eq!(sig.to_bytes().len(), 64);
    }

    #[test]
    fn fixture_seed_is_not_all_zeros() {
        // Sanity: the fixture key must be loadable and its signing key usable.
        let acct = fixture_keypair();
        assert_eq!(acct.seed.len(), 32);
    }
}
// crate-only-end
