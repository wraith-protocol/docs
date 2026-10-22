// src/send.rs
//
// Build and submit a stealth payment via the stealth-sender Soroban contract.
// Gated behind the "network" feature — soroban-client and reqwest are not
// pulled in for the CI compile-only check.

// NOTE: soroban-client does not yet expose a stable Rust API matching the
// builder shape shown in the quickstart guide (the guide documents the planned
// interface).  This module compiles as a structural stub so that the types,
// function signatures, and overall shape are verified by rustc, while the
// concrete RPC calls remain behind the "network" feature gate.

#[cfg(feature = "network")]
use anyhow::Result;
#[cfg(feature = "network")]
use rand::{rngs::OsRng, RngCore};

#[cfg(feature = "network")]
use crate::network::{ANNOUNCER, RPC_URL, SCHEME_ID};
#[cfg(feature = "network")]
use crate::stealth::generate_stealth_address;

/// Send a stealth payment to a recipient identified by their spending and
/// viewing public keys.
///
/// Returns the transaction hash on success.
#[cfg(feature = "network")]
pub async fn send_stealth_payment(
    sender_seed: &[u8; 32],
    sender_address: &str,
    token: &str, // Stellar Asset Contract id, e.g. XLM or USDC SAC
    recipient_spending: &[u8; 32],
    recipient_viewing_seed: &[u8; 32],
    amount: i128,
) -> Result<String> {
    // 1. Fresh ephemeral key for this payment.
    let mut eph_seed = [0u8; 32];
    OsRng.fill_bytes(&mut eph_seed);

    // 2. Recipient's one-time stealth address.
    let stealth = generate_stealth_address(recipient_spending, recipient_viewing_seed, &eph_seed);

    // 3. Build + submit a `stealth-sender.send` invocation via soroban-client.
    //    The exact builder API depends on the soroban-client version you target;
    //    the shape below matches the planned 0.10+ interface documented in the
    //    quickstart guide.  Adapt method names to your installed version.
    let _ = (
        sender_seed,
        sender_address,
        token,
        amount,
        stealth,
        ANNOUNCER,
        RPC_URL,
        SCHEME_ID,
    );
    anyhow::bail!("send_stealth_payment: wire up soroban-client builder for your target version")
}
