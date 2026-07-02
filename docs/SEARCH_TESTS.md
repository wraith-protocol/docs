# Mintlify Search Tests

These tests verify that our Mintlify search configuration (synonyms, boosts, and keywords) yields the most relevant pages for common Stellar developer queries.

## Test Queries and Expected Results

1. **`stealth`**
   - **Expected Result:** `How Stealth Payments Work` (or related stealth guides)
   - **Reasoning:** Tests the core concept.

2. **`unlinkable`**
   - **Expected Result:** `How Stealth Payments Work`
   - **Reasoning:** Tests synonym mapping `stealth ↔ unlinkable`.

3. **`meta-address`**
   - **Expected Result:** Stealth payments / Architecture overview
   - **Reasoning:** Tests core terminology.

4. **`metaaddress`**
   - **Expected Result:** Stealth payments / Architecture overview
   - **Reasoning:** Tests synonym mapping `meta-address ↔ metaaddress ↔ meta address`.

5. **`Soroban`**
   - **Expected Result:** `Stellar Contracts`
   - **Reasoning:** Tests synonym mapping `Soroban ↔ Stellar smart contract`.

6. **`Stellar smart contract`**
   - **Expected Result:** `Stellar Contracts`
   - **Reasoning:** Ensures explicit terminology maps correctly.

7. **`friendbot`**
   - **Expected Result:** Stellar testing/troubleshooting guides
   - **Reasoning:** Tests synonym mapping `friendbot ↔ testnet faucet`.

8. **`testnet faucet`**
   - **Expected Result:** Stellar testing/troubleshooting guides
   - **Reasoning:** Tests synonym mapping for friendbot.

9. **`XLM`**
   - **Expected Result:** Stellar core pages (Getting Started / Primitives)
   - **Reasoning:** Tests synonym mapping `XLM ↔ lumen`.

10. **`lumen`**
    - **Expected Result:** Stellar core pages
    - **Reasoning:** Tests synonym mapping for XLM.

11. **`Freighter`**
    - **Expected Result:** `Stellar Transaction Simulation` / Wallet guides
    - **Reasoning:** Tests synonym mapping `Freighter ↔ Stellar wallet`.

12. **`Stellar wallet`**
    - **Expected Result:** `Stellar Transaction Simulation` / Wallet guides
    - **Reasoning:** Tests synonym mapping for Freighter.

13. **`stellar.expert`**
    - **Expected Result:** `Stellar Troubleshooting Guide` or `Stellar Mainnet Deployment`
    - **Reasoning:** Tests frontmatter keyword injection for Stellar pages.

14. **`path payment`**
    - **Expected Result:** `Stellar Custom Assets` or core Stellar guides
    - **Reasoning:** Tests frontmatter keyword injection for Stellar pages.

15. **`getting started stellar`**
    - **Expected Result:** `Getting Started`
    - **Reasoning:** Tests page weighting (getting-started > guides > reference). The Overview section's `getting-started` page should appear first due to the boost weight `3`.

## Acceptance Criteria Checklist

- [x] Search analytics enabled in `docs.json`
- [x] Synonyms configured for key Stellar terms
- [x] Page weighting implemented to prioritize Getting Started and Guides
- [x] Stellar keywords injected into `.mdx` frontmatter
- [ ] Manual verification completed for each query above
