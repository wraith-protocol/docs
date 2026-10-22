// programs/wraith-announcer/src/lib.rs
//
// Structural fixture for contracts/solana.mdx § wraith-announcer.
//
// Emits announcement events via Anchor's emit!() macro.
// Stateless — no on-chain storage.
//
// This crate mirrors the *shape* of the canonical program — instruction
// signatures, account contexts, account layouts, events, and error codes — so
// the documented snippets can be type-checked in CI. It is a documentation
// fixture, not the program that runs on chain: it is not deployed, and its
// instruction bodies are abbreviated or omitted.
//
// Program ID matches the deployed devnet program recorded in the canonical
// deployment manifest (wraith-protocol/contracts deployments/solana) and in
// `getDeployment("solana")` from @wraith-protocol/sdk.

use anchor_lang::prelude::*;

declare_id!("9Ko7TuXHpLUH1ZsZWQEpeA9Tv7hX325ooWk5SD7Y9nuq");

#[program]
pub mod wraith_announcer {
    use super::*;

    /// Emit a stealth address announcement.
    ///
    /// scheme_id         — stealth scheme identifier (use SCHEME_ID from SDK)
    /// stealth_address   — the one-time stealth Pubkey
    /// ephemeral_pub_key — 32-byte ephemeral public key
    /// metadata          — view tag + optional bytes (first byte = view tag)
    pub fn announce(
        ctx: Context<Announce>,
        scheme_id: u32,
        stealth_address: Pubkey,
        ephemeral_pub_key: [u8; 32],
        metadata: Vec<u8>,
    ) -> Result<()> {
        emit!(AnnouncementEvent {
            scheme_id,
            stealth_address,
            caller: ctx.accounts.caller.key(),
            ephemeral_pub_key,
            metadata,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Announce<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

#[event]
pub struct AnnouncementEvent {
    pub scheme_id: u32,
    pub stealth_address: Pubkey,
    pub caller: Pubkey,
    pub ephemeral_pub_key: [u8; 32],
    pub metadata: Vec<u8>,
}
