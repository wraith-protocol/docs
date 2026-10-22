// programs/wraith-names/src/lib.rs
//
// Structural fixture for contracts/solana.mdx § wraith-names.
//
// PDA-based name to meta-address mapping.
// Names are stored in Program Derived Addresses seeded by ["name", nameBytes].
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

declare_id!("4JrrQh5aK7iLvx6MgtEQk7K7X3SsWfTLxVJu1jXEwNjD");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum byte length of the stored name.
pub const MAX_NAME_LEN: usize = 32;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod wraith_names {
    use super::*;

    /// Register a new `.wraith` name.
    ///
    /// The name format is validated and the supplied meta-address is stored
    /// as-is. Record ownership is tied to the registrant's Solana wallet
    /// (`owner`); the meta-address itself is not authenticated on chain.
    pub fn register(ctx: Context<Register>, name: String, meta_address: [u8; 64]) -> Result<()> {
        require!(
            name.len() >= 3 && name.len() <= MAX_NAME_LEN,
            WraithError::InvalidNameLength
        );
        require!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            WraithError::InvalidNameCharacter
        );

        let record = &mut ctx.accounts.name_record;
        record.name = name;
        record.meta_address = meta_address;
        record.owner = ctx.accounts.owner.key();
        record.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Update the meta-address for a name you own.
    pub fn update(ctx: Context<Update>, new_meta_address: [u8; 64]) -> Result<()> {
        require!(
            ctx.accounts.name_record.owner == ctx.accounts.owner.key(),
            WraithError::NotOwner
        );
        ctx.accounts.name_record.meta_address = new_meta_address;
        Ok(())
    }

    /// Release a name. Closes the PDA account and returns rent to the owner.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        require!(
            ctx.accounts.name_record.owner == ctx.accounts.owner.key(),
            WraithError::NotOwner
        );
        // Account closure is handled by the `close = owner` constraint below.
        Ok(())
    }

    /// Look up a name's meta-address. Read-only.
    ///
    /// ABBREVIATED: production clients call
    /// `program.account.nameRecord.fetch(pda)` directly; this instruction
    /// exists to document the on-chain interface shape.
    pub fn resolve(ctx: Context<Resolve>) -> Result<[u8; 64]> {
        Ok(ctx.accounts.name_record.meta_address)
    }
}

// ---------------------------------------------------------------------------
// Account data
// ---------------------------------------------------------------------------

/// On-chain storage for a single `.wraith` name registration.
///
/// PDA seeds: [b"name", name.as_bytes()]
/// Global uniqueness is enforced by the PDA derivation — only one live
/// account can exist per (program_id, seeds) combination.
#[account]
pub struct NameRecord {
    pub name: String,           // max 32 bytes
    pub meta_address: [u8; 64], // spending pub (32) + viewing pub (32)
    pub owner: Pubkey,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Accounts contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(name: String)]
pub struct Register<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 4 + MAX_NAME_LEN + 64 + 32 + 8,
        seeds = [b"name", name.as_bytes()],
        bump,
    )]
    pub name_record: Account<'info, NameRecord>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(mut)]
    pub name_record: Account<'info, NameRecord>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, close = owner)]
    pub name_record: Account<'info, NameRecord>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub name_record: Account<'info, NameRecord>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum WraithError {
    #[msg("Name must be 3-32 characters")]
    InvalidNameLength,
    #[msg("Name must be lowercase alphanumeric or hyphens")]
    InvalidNameCharacter,
    #[msg("Only the owner can modify this name")]
    NotOwner,
}
