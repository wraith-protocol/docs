// src/stealth.rs
//
// Self-contained reimplementation of the Wraith Stellar stealth spec.
// Mirrors deriveStealthKeys / generateStealthAddress / scanAnnouncements
// from @wraith-protocol/sdk/chains/stellar.
//
// Cryptographic primitives: ed25519 + X25519, domain-separated SHA-256.

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, EdwardsPoint, Scalar,
};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

// ── Public types ──────────────────────────────────────────────────────────────

pub struct StealthKeys {
    pub spending_seed: [u8; 32],
    pub viewing_seed: [u8; 32],
    pub spending_scalar: Scalar,
    pub spending_pub: [u8; 32],
    pub viewing_pub: [u8; 32],
}

pub struct GeneratedStealth {
    pub stealth_address: String,
    pub ephemeral_pub: [u8; 32],
    pub view_tag: u8,
}

pub struct MatchedStealth {
    pub stealth_address: String,
    pub stealth_scalar: Scalar,
    pub stealth_pub: [u8; 32],
}

// ── Domain-separated derivation (mirrors the TS spec) ────────────────────────

fn derive_seed(tag: &str, sig: &[u8; 64]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag.as_bytes());
    h.update(sig);
    let out = h.finalize();
    let mut b = [0u8; 32];
    b.copy_from_slice(&out);
    b
}

/// ed25519 private scalar: SHA-512(seed)[0..32], clamped (RFC 8032 §5.1.5).
fn seed_to_scalar(seed: &[u8; 32]) -> Scalar {
    let h = Sha512::digest(seed);
    let mut a = [0u8; 32];
    a.copy_from_slice(&h[0..32]);
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    Scalar::from_bytes_mod_order(a)
}

fn pubkey_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn derive_stealth_keys(sig: &[u8; 64]) -> StealthKeys {
    let spending_seed = derive_seed("wraith:spending:", sig);
    let viewing_seed = derive_seed("wraith:viewing:", sig);
    let spending_scalar = seed_to_scalar(&spending_seed);
    StealthKeys {
        spending_seed,
        viewing_seed,
        spending_scalar,
        spending_pub: pubkey_from_seed(&spending_seed),
        viewing_pub: pubkey_from_seed(&viewing_seed),
    }
}

// ── X25519 ECDH between ed25519 keys (Montgomery form) ───────────────────────

fn edwards_pub_to_mont_pub(pub_bytes: &[u8; 32]) -> [u8; 32] {
    let compressed = CompressedEdwardsY::from_slice(pub_bytes)
        .expect("32-byte slice always fits CompressedEdwardsY");
    let point = compressed.decompress().expect("valid ed25519 public key");
    point.to_montgomery().to_bytes()
}

fn x25519_shared(priv_seed: &[u8; 32], peer_pub: &[u8; 32]) -> [u8; 32] {
    // The clamped ed25519 scalar bytes are a valid x25519 private key.
    let a = seed_to_scalar(priv_seed).to_bytes();
    let secret = StaticSecret::from(a);
    let peer = X25519PublicKey::from(edwards_pub_to_mont_pub(peer_pub));
    secret.diffie_hellman(&peer).to_bytes()
}

fn hash_to_scalar(domain: &str, shared: &[u8; 32]) -> Scalar {
    let mut h = Sha256::new();
    h.update(domain.as_bytes());
    h.update(shared);
    let out = h.finalize();
    let mut b = [0u8; 32];
    b.copy_from_slice(&out);
    Scalar::from_bytes_mod_order(b)
}

pub fn compute_view_tag(shared: &[u8; 32]) -> u8 {
    hash_to_scalar("wraith:tag:", shared).to_bytes()[0]
}

// ── Generate a one-time stealth address for a recipient ───────────────────────
//
// Callers supply the recipient's viewing *seed* (not just the public key)
// because ECDH requires the private scalar.  After calling derive_stealth_keys
// the viewing_seed is available directly on StealthKeys.

pub fn generate_stealth_address(
    spending_pub: &[u8; 32],
    viewing_seed: &[u8; 32],
    ephemeral_seed: &[u8; 32],
) -> GeneratedStealth {
    let eph_pub = SigningKey::from_bytes(ephemeral_seed)
        .verifying_key()
        .to_bytes();
    // shared = X25519(viewing_priv, ephemeral_pub)
    let shared = x25519_shared(viewing_seed, &eph_pub);
    let view_tag = compute_view_tag(&shared);
    let h_scalar = hash_to_scalar("wraith:scalar:", &shared);

    let spend_point = CompressedEdwardsY::from_slice(spending_pub)
        .expect("32-byte slice always fits CompressedEdwardsY")
        .decompress()
        .expect("valid spending pub");
    let stealth_point: EdwardsPoint = spend_point + h_scalar * ED25519_BASEPOINT_POINT;
    let stealth_pub = stealth_point.compress().to_bytes();
    let stealth_address = stellar_strkey::ed25519::PublicKey(stealth_pub).to_string();

    GeneratedStealth {
        stealth_address,
        ephemeral_pub: eph_pub,
        view_tag,
    }
}

// ── Scan announcements and recover the stealth private scalar ─────────────────

pub fn scan_announcements(
    announcements: &[(String, [u8; 32], u8)], // (stealth_address, ephemeral_pub, view_tag)
    viewing_seed: &[u8; 32],
    spending_pub: &[u8; 32],
    spending_scalar: Scalar,
) -> Vec<MatchedStealth> {
    let spend_point = CompressedEdwardsY::from_slice(spending_pub)
        .expect("32-byte slice always fits CompressedEdwardsY")
        .decompress()
        .expect("valid spending pub");
    let mut matched = Vec::new();

    for (addr, eph_pub, tag) in announcements {
        // Fast prefilter: skip ~255/256 non-matches on the view tag alone.
        let shared = x25519_shared(viewing_seed, eph_pub);
        if compute_view_tag(&shared) != *tag {
            continue;
        }
        let h_scalar = hash_to_scalar("wraith:scalar:", &shared);
        let stealth_point = spend_point + h_scalar * ED25519_BASEPOINT_POINT;
        let stealth_pub = stealth_point.compress().to_bytes();
        if stellar_strkey::ed25519::PublicKey(stealth_pub).to_string() == *addr {
            matched.push(MatchedStealth {
                stealth_address: addr.clone(),
                stealth_scalar: spending_scalar + h_scalar,
                stealth_pub,
            });
        }
    }
    matched
}

// ── Sign with a raw stealth scalar (ed25519 / RFC 8032) ───────────────────────
//
// Needed to spend funds received at a stealth address.

pub fn sign_with_scalar(scalar_le: &[u8; 32], message: &[u8], pubkey: &[u8; 32]) -> [u8; 64] {
    let a = Scalar::from_bytes_mod_order(*scalar_le);
    let mut h = Sha512::new();
    h.update(scalar_le);
    h.update(message);
    let r = Scalar::from_bytes_mod_order(h.finalize()[0..32].try_into().unwrap());
    let r_point = r * ED25519_BASEPOINT_POINT;
    let r_bytes = r_point.compress().to_bytes();
    let mut k = Sha512::new();
    k.update(&r_bytes);
    k.update(pubkey);
    k.update(message);
    let k = Scalar::from_bytes_mod_order(k.finalize()[0..32].try_into().unwrap());
    let s = r + k * a;
    let mut sig = [0u8; 64];
    sig[0..32].copy_from_slice(&r_bytes);
    sig[32..64].copy_from_slice(&s.to_bytes());
    sig
}

// crate-only-begin: unit tests, not shown in the guide
// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::fixture_keypair;
    use crate::network::STEALTH_SIGNING_MESSAGE;
    use ed25519_dalek::Signer;

    fn fixture_sig() -> [u8; 64] {
        fixture_keypair()
            .signing_key
            .sign(STEALTH_SIGNING_MESSAGE.as_bytes())
            .to_bytes()
    }

    #[test]
    fn derive_stealth_keys_is_deterministic() {
        let sig = fixture_sig();
        let k1 = derive_stealth_keys(&sig);
        let k2 = derive_stealth_keys(&sig);
        assert_eq!(k1.spending_pub, k2.spending_pub);
        assert_eq!(k1.viewing_pub, k2.viewing_pub);
    }

    #[test]
    fn spending_and_viewing_seeds_differ() {
        let sig = fixture_sig();
        let keys = derive_stealth_keys(&sig);
        assert_ne!(
            keys.spending_seed, keys.viewing_seed,
            "seeds must be distinct"
        );
    }

    #[test]
    fn generate_and_scan_round_trip() {
        let sig = fixture_sig();
        let keys = derive_stealth_keys(&sig);

        // Use a fixed ephemeral seed so the test is deterministic.
        let ephemeral_seed = [0x42u8; 32];

        let generated =
            generate_stealth_address(&keys.spending_pub, &keys.viewing_seed, &ephemeral_seed);

        // The generated address must be a valid G... Stellar address.
        assert!(generated.stealth_address.starts_with('G'));

        // Scanning with the correct keys must find exactly one match.
        let announcements = vec![(
            generated.stealth_address.clone(),
            generated.ephemeral_pub,
            generated.view_tag,
        )];
        let found = scan_announcements(
            &announcements,
            &keys.viewing_seed,
            &keys.spending_pub,
            keys.spending_scalar,
        );
        assert_eq!(found.len(), 1, "should find exactly one match");
        assert_eq!(found[0].stealth_address, generated.stealth_address);
    }

    #[test]
    fn wrong_view_tag_is_filtered() {
        let sig = fixture_sig();
        let keys = derive_stealth_keys(&sig);
        let ephemeral_seed = [0x07u8; 32];
        let generated =
            generate_stealth_address(&keys.spending_pub, &keys.viewing_seed, &ephemeral_seed);

        // Corrupt the view tag: scan should produce no matches.
        let bad_tag = generated.view_tag.wrapping_add(1);
        let announcements = vec![(
            generated.stealth_address.clone(),
            generated.ephemeral_pub,
            bad_tag,
        )];
        let found = scan_announcements(
            &announcements,
            &keys.viewing_seed,
            &keys.spending_pub,
            keys.spending_scalar,
        );
        assert_eq!(found.len(), 0, "corrupted view tag must be filtered");
    }
}
// crate-only-end
