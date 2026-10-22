// src/scan.rs
//
// Fetch announcements from the Soroban RPC getEvents endpoint and scan them.
// Gated behind the "network" feature so CI can compile the crypto modules
// without reqwest / tokio.

#[cfg(feature = "network")]
use anyhow::Result;
#[cfg(feature = "network")]
use serde_json::Value;

#[cfg(feature = "network")]
use crate::network::{ANNOUNCER, RPC_URL};
#[cfg(feature = "network")]
use crate::stealth::scan_announcements;

#[cfg(feature = "network")]
pub async fn fetch_announcements(start_ledger: u32) -> Result<Vec<(String, [u8; 32], u8)>> {
    let client = reqwest::Client::new();
    let req = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "getEvents",
        "params": {
            "startLedger": start_ledger,
            "filters": [{
                "type": "contract",
                "contractIds": [ANNOUNCER],
                "topics": [["announce"]]
            }],
            "pagination": { "limit": 100 }
        }
    });

    let resp: Value = client.post(RPC_URL).json(&req).send().await?.json().await?;
    let events = resp["result"]["events"].as_array().unwrap();

    let mut out = Vec::new();
    for e in events {
        // `data` is base64 XDR of a ContractEvent. Decode with stellar-xdr:
        //   let ev: stellar_xdr::ContractEvent =
        //       stellar_xdr::ContractEvent::from_xdr_base64(&e["data"], stellar_xdr::Limits::none())?;
        // Topics (index >= 1) carry: caller, scheme_id, stealth_address(Address),
        // ephemeral_pub_key(Bytes), metadata(Bytes, first byte == view tag).
        let stealth_address = e["topics"][3].as_str().unwrap().to_string();
        let ephemeral_hex = e["topics"][4].as_str().unwrap();
        let ephemeral_pub: [u8; 32] = hex::decode(ephemeral_hex)?.try_into().unwrap();
        let metadata_hex = e["topics"][5].as_str().unwrap();
        let metadata = hex::decode(metadata_hex)?;
        let view_tag = metadata[0];
        out.push((stealth_address, ephemeral_pub, view_tag));
    }
    Ok(out)
}

#[cfg(feature = "network")]
pub async fn run_scan(secret: &str) -> Result<()> {
    use crate::keypair::load_keypair;
    use crate::network::STEALTH_SIGNING_MESSAGE;
    use ed25519_dalek::Signer;

    let account = load_keypair(secret)?;
    let sig: [u8; 64] = account
        .signing_key
        .sign(STEALTH_SIGNING_MESSAGE.as_bytes())
        .to_bytes();
    let keys = crate::stealth::derive_stealth_keys(&sig);

    let announcements = fetch_announcements(1).await?;
    let matched = scan_announcements(
        &announcements,
        &keys.viewing_seed,
        &keys.spending_pub,
        keys.spending_scalar,
    );
    println!("found {} incoming stealth payment(s)", matched.len());
    Ok(())
}
