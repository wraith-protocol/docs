// src/network.rs
// Compile-time network selection. Flip with --features futurenet / --features mainnet.

#[cfg(feature = "testnet")]
pub const NETWORK_PASSPHRASE: &str = "Test SDF Network ; September 2015";
#[cfg(feature = "testnet")]
pub const RPC_URL: &str = "https://soroban-testnet.stellar.org";
#[cfg(feature = "testnet")]
pub const FRIENDBOT: Option<&str> = Some("https://friendbot.stellar.org");
#[cfg(feature = "testnet")]
pub const ANNOUNCER: &str = "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL";

#[cfg(feature = "futurenet")]
pub const NETWORK_PASSPHRASE: &str = "Test SDF Future Network ; October 2022";
#[cfg(feature = "futurenet")]
pub const RPC_URL: &str = "https://rpc-futurenet.stellar.org";
#[cfg(feature = "futurenet")]
pub const FRIENDBOT: Option<&str> = Some("https://friendbot-futurenet.stellar.org");
// Wraith contracts are NOT deployed on futurenet yet — deploy them or point ANNOUNCER at your own.
#[cfg(feature = "futurenet")]
pub const ANNOUNCER: &str = "<your-announcer-contract-id>";

#[cfg(feature = "mainnet")]
pub const NETWORK_PASSPHRASE: &str = "Public Global Stellar Network ; September 2015";
#[cfg(feature = "mainnet")]
pub const RPC_URL: &str = "https://mainnet.stellar.validationcloud.io/v1/<API_KEY>";
#[cfg(feature = "mainnet")]
pub const FRIENDBOT: Option<&str> = None;
#[cfg(feature = "mainnet")]
pub const ANNOUNCER: &str = "<your-mainnet-announcer-contract-id>";

pub const SCHEME_ID: u32 = 1;
pub const STEALTH_SIGNING_MESSAGE: &str =
    "Sign this message to generate your Wraith stealth keys.\n\nChain: Stellar\nNote: This signature is used for key derivation only and does not authorize any transaction.";
