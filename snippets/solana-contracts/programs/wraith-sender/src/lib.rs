// programs/wraith-sender/src/lib.rs
//
// Structural fixture for contracts/solana.mdx § wraith-sender.
//
// Atomic SOL or SPL token transfer + announcement in one instruction.
// Sends funds to the stealth address and emits an announcement event.
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
use anchor_spl::token::{Token, TokenAccount};

declare_id!("E6J7GBSTjKbYANWjfTo5HfnXZ4Tg3LAasN7NrvCwn5Dq");

// ---------------------------------------------------------------------------
// Announcement event (re-declared here; in production import from a shared
// crate or CPI into wraith-announcer).
// ---------------------------------------------------------------------------

#[event]
pub struct AnnouncementEvent {
    pub scheme_id: u32,
    pub stealth_address: Pubkey,
    pub caller: Pubkey,
    pub ephemeral_pub_key: [u8; 32],
    pub metadata: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod wraith_sender {
    use super::*;

    /// Transfer SOL to a stealth address and emit an announcement.
    pub fn send_sol(
        ctx: Context<SendSol>,
        amount: u64,
        scheme_id: u32,
        stealth_address: Pubkey,
        ephemeral_pub_key: [u8; 32],
        metadata: Vec<u8>,
    ) -> Result<()> {
        // Transfer SOL via system program CPI.
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.sender.key(),
            &ctx.accounts.stealth_account.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.sender.to_account_info(),
                ctx.accounts.stealth_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(AnnouncementEvent {
            scheme_id,
            stealth_address,
            caller: ctx.accounts.sender.key(),
            ephemeral_pub_key,
            metadata,
        });
        Ok(())
    }

    /// Transfer SPL tokens to a stealth address's associated token account
    /// and emit an announcement.
    pub fn send_spl(
        ctx: Context<SendSpl>,
        amount: u64,
        scheme_id: u32,
        stealth_address: Pubkey,
        ephemeral_pub_key: [u8; 32],
        metadata: Vec<u8>,
    ) -> Result<()> {
        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.stealth_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        anchor_spl::token::transfer(cpi_ctx, amount)?;

        emit!(AnnouncementEvent {
            scheme_id,
            stealth_address,
            caller: ctx.accounts.sender.key(),
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
pub struct SendSol<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    /// CHECK: stealth address, receives SOL
    #[account(mut)]
    pub stealth_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendSpl<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(mut)]
    pub sender_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stealth_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
