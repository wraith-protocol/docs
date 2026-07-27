# Stellar Asset Contract (SAC) Compatibility Audit
**Date:** June 2026  
**Scope:** `stealth-sender` v1.2, `stealth-announcer` v1.1  
**Protocol version:** Stellar Protocol 22 (Mainnet) / Protocol 22 (Testnet)  
**Auditor:** Wraith Protocol internal security review  

---

## Summary

This document records the results of a compatibility review between the Wraith `stealth-sender` and `stealth-announcer` Soroban contracts and the Stellar Asset Contract (SAC) for each asset class likely to be used in production. The goal is to identify which SAC flag combinations work transparently, which require special handling, and which are incompatible with stealth address flows.

---

## Compatibility Matrix

| Asset | Issuer flags | `stealth-sender` send | Trustline auto-create (`trust()`) | Clawback risk | Recommended |
|---|---|---|---|---|---|
| XLM (native) | — | ✅ Works | N/A — native asset | ❌ Cannot be clawed back | ✅ Safe |
| USDC (Circle mainnet) | None | ✅ Works | ✅ Protocol 22+ (`trust()`) | ❌ No clawback | ✅ Safe |
| USDC (Circle testnet) | None | ✅ Works | ✅ Protocol 22+ (`trust()`) | ❌ No clawback | ✅ Safe |
| EURC (Circle mainnet) | None | ✅ Works | ✅ Protocol 22+ (`trust()`) | ❌ No clawback | ✅ Safe |
| Generic asset (no flags) | None | ✅ Works | ✅ Protocol 22+ (`trust()`) | ❌ No clawback | ✅ Safe |
| Asset with `AUTH_REQUIRED` | `AUTH_REQUIRED` | ⚠️ Blocked until `set_auth` | ✅ Trustline created, but blocked | ❌ No clawback | ⚠️ Manual auth step needed |
| Asset with `AUTH_REVOCABLE` | `AUTH_REVOCABLE` | ✅ Works (unless deauthorized) | ✅ Works | ❌ No clawback | ⚠️ Monitor for deauth |
| Asset with clawback | `AUTH_CLAWBACK_ENABLED` + `AUTH_REVOCABLE` | ✅ Works | ✅ Works | ✅ **Issuer CAN claw back** | ❌ Not recommended |
| Asset with all flags | All three | ⚠️ Blocked until `set_auth` | ✅ Trustline created, but blocked | ✅ **Issuer CAN claw back** | ❌ Incompatible |
| Issuer's own account (send TO issuer) | — | ✅ Works (burns token) | N/A | N/A | ⚠️ Burning, not transfer |
| Issuer's own account (send FROM issuer) | — | ✅ Works (mints token) | N/A | N/A | ⚠️ Minting, not transfer |

---

## Findings

### F-01 — USDC and EURC: no flags, fully compatible

**Severity:** Informational  
**Assets affected:** USDC (Circle mainnet + testnet), EURC (Circle mainnet)

Circle issues USDC and EURC on Stellar without any restrictive flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, `AUTH_CLAWBACK_ENABLED`). Both assets are fully compatible with stealth-sender: `transfer()` proceeds without additional authorization, and Protocol 22's `trust()` function allows stealth-sender to create the trustline on the recipient stealth address atomically within the same transaction.

**Action required:** None. Use USDC and EURC freely.

---

### F-02 — Protocol 22 `trust()` eliminates separate trustline setup

**Severity:** Informational  
**Assets affected:** All non-native assets

Prior to Protocol 22 (Yardstick), a recipient stealth address had to hold an existing trustline before any SAC `transfer()` could succeed. This required a two-transaction flow: first `changeTrust` from the stealth address private key, then the stealth-sender invocation. Since stealth address private keys are derived scalars (not standard seeds), this was cumbersome.

Protocol 22 introduced `SAC.trust(addr)`, callable from within a contract. `stealth-sender` v1.2 calls `token.trust(stealth_address)` before `token.transfer()` for every send. The `trust()` call is a no-op if the trustline already exists.

**Requirement:** The sender must include a base reserve contribution (0.5 XLM per new trustline entry) in their transaction fee budget, or fund the stealth address account to cover the reserve before sending.

**Action required:** Ensure sender account has at least 0.5 XLM beyond the transfer amount for each new trustline entry created.

---

### F-03 — `AUTH_REQUIRED` flag blocks transfers to new stealth addresses

**Severity:** High  
**Assets affected:** Any asset where the issuer has set `AUTH_REQUIRED_FLAG`

When `AUTH_REQUIRED` is set, every new trustline created by `trust()` starts in the deauthorized state. The SAC will reject `transfer()` with `BalanceDeauthorizedError` (error code 11) until the issuer explicitly calls `set_authorized(stealth_address, true)`.

This creates a fundamental incompatibility with stealth address flows: the sender generates a fresh one-time address per payment, but the issuer has no way to know the stealth address in advance to authorize it. Authorizing it after the fact breaks the privacy model.

**USDC and EURC are NOT affected** — Circle does not set `AUTH_REQUIRED` on these assets.

**Action required:**  
- Do not use `stealth-sender` with `AUTH_REQUIRED` assets.  
- If your use case requires `AUTH_REQUIRED` assets, use classic Stellar payment operations to the recipient's main account (not the stealth address) and handle key management separately.

---

### F-04 — `AUTH_CLAWBACK_ENABLED` allows issuer to reclaim stealth balances

**Severity:** High  
**Assets affected:** Any asset with `AUTH_CLAWBACK_ENABLED_FLAG` set (requires `AUTH_REVOCABLE_FLAG` also set)

When `AUTH_CLAWBACK_ENABLED` is set on the issuing account, the asset issuer can call `clawback(from, amount)` on any balance, including balances held by stealth addresses. A malicious or legally compelled issuer could claw back funds from stealth addresses without the holder's consent.

Additionally: when a `G...` account (stealth address) receives an asset from a contract for the first time, the clawback-enabled state is inherited from the issuing account's flags at the time the balance entry was created.

**USDC and EURC are NOT affected** — Circle does not set `AUTH_CLAWBACK_ENABLED`.

**Action required:**  
- Warn users before sending clawback-enabled assets via stealth payments.  
- The Wraith agent displays a warning when `AUTH_CLAWBACK_ENABLED` is detected.  
- Do not use clawback-enabled assets for stealth payments requiring unconditional custody guarantees.

---

### F-05 — `AUTH_REVOCABLE` without clawback: monitor for deauthorization

**Severity:** Medium  
**Assets affected:** Any asset with `AUTH_REVOCABLE_FLAG` set (without `AUTH_CLAWBACK_ENABLED`)

Assets with `AUTH_REVOCABLE` allow the issuer to call `set_authorized(address, false)`, which deauthorizes a trustline and prevents transfers. The issuer cannot, however, claw back the balance — the holder retains ownership but cannot transact.

Deauthorization of a stealth address trustline would trap funds: the recipient can scan and detect the payment, derive the private key, but cannot transfer the balance until the issuer re-authorizes.

**Action required:**  
- Treat `AUTH_REVOCABLE` assets as elevated-risk for stealth payment use cases.  
- Monitor trustline authorization status if building wallets for `AUTH_REVOCABLE` assets.

---

### F-06 — Transfer-to-issuer burns; transfer-from-issuer mints

**Severity:** Informational  
**Assets affected:** All issued assets (not native XLM)

SAC behaviour: sending tokens to the issuer account triggers a burn (tokens are destroyed). Sending tokens from the issuer account triggers a mint (tokens are created). The stealth-sender contract does not prevent transfers to or from the issuer address.

If a stealth address happens to be generated that matches the issuer address (statistically impossible with secure randomness but worth documenting), the payment would be burned rather than received.

**Action required:** None in practice. Document for completeness.

---

### F-07 — 64-bit vs 128-bit amount limits for account trustlines

**Severity:** Low  
**Assets affected:** All issued assets when recipient is a `G...` account

Trustline balances are stored as 64-bit signed integers (`i64`, max ~9.22 × 10¹⁸). The SAC interface accepts `i128`. Any `transfer()` or `trust()` call with an amount exceeding `i64::MAX` will fail with `BalanceError` (error code 10).

For USDC (7 decimal places), the effective maximum single stealth payment is `922,337,203,685.4775807 USDC` — far beyond any realistic payment. Not a practical concern for USDC but could matter for assets with fewer decimal places.

**Action required:** None for USDC. Document for asset issuers who use non-standard decimal configurations.

---

## Issuer Addresses

| Asset | Network | Issuer Address |
|---|---|---|
| USDC | Mainnet | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| USDC | Testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| EURC | Mainnet | `GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP` |
| EURC | Testnet | `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` |
| XLM  | Mainnet | Native (no issuer) |
| XLM  | Testnet | Native (no issuer) |

Sources: [Circle USDC Contract Addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), verified June 2026.

---

## Test Results

All tests run on Stellar Testnet (Protocol 22). Transactions verified via [Stellar Expert Testnet](https://stellar.expert/explorer/testnet).

| Test case | Input | Expected | Result |
|---|---|---|---|
| USDC send via stealth-sender, no existing trustline | 100 USDC | Trust created + 100 USDC received at stealth addr | ✅ Pass |
| USDC send via stealth-sender, trustline exists | 50 USDC | 50 USDC received | ✅ Pass |
| USDC batch_send (3 recipients) | 3 × 100 USDC | 3 trustlines created, 3 × 100 received | ✅ Pass |
| AUTH_REQUIRED asset send, unauth trustline | 100 TEST | BalanceDeauthorizedError (code 11) | ✅ Correctly blocked |
| AUTH_REQUIRED asset send, pre-authed trustline | 100 TEST | 100 TEST received | ✅ Pass |
| Clawback-enabled asset, post-send clawback | 100 TEST → clawback | Balance removed from stealth addr | ✅ Clawback confirmed |
| USDC send, sender below 0.5 XLM reserve | 100 USDC | Fails: insufficient balance for new entry | ✅ Correctly rejected |
| XLM createAccount + USDC send in 2-op tx | 1.5 XLM + 100 USDC | Account created, XLM funded, USDC trust + transfer | ✅ Pass |

---

## Conclusion

USDC and EURC (Circle) are fully compatible with stealth-sender and stealth-address flows on Stellar. No special handling is required beyond ensuring the sender holds 0.5 XLM per new trustline created.

Assets with `AUTH_REQUIRED` are incompatible with stealth payment flows — the issuer cannot pre-authorize an address that doesn't exist yet. Assets with `AUTH_CLAWBACK_ENABLED` are usable but carry issuer clawback risk that must be disclosed to users.

The Wraith SDK and agent surface these warnings automatically.

---

## See Also

- [Threat Model](/reference/threat-model) — full STRIDE analysis for all Wraith Protocol contracts, including residual risk R-05 which covers the SAC flag hazards documented here
- [Privacy Best Practices](/guides/privacy-best-practices) — withdrawal timing, amount hygiene, and address reuse guidance
