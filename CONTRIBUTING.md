# Contributing

## Search review cadence

Review documentation search once per quarter. The goal is to catch terms that users already try, then either add the missing page content or add internal search keywords to the page that should answer the query.

1. Open the Mintlify dashboard analytics page and switch to human traffic.
2. Review the top 20 search queries with low click-through rate or no satisfying result.
3. For each query, decide whether the fix is:
   - new or expanded documentation content,
   - a `keywords` frontmatter update on an existing page,
   - a navigation or frontmatter `boost` adjustment.
4. Open a docs PR with the query list, chosen fixes, and manual verification notes.

You can also pull the same data from the Mintlify CLI after logging in:

```bash
mint analytics search --from 2026-01-01
```

For automation, use the Mintlify Analytics API search export with a server-side admin API key:

```bash
curl --request GET \
  --url "https://api.mintlify.com/v1/analytics/{projectId}/searches?limit=100" \
  --header "Authorization: Bearer $MINTLIFY_ADMIN_API_KEY"
```

## Search metadata rules

- Put user-facing synonyms in each page's `keywords` frontmatter.
- Keep keywords specific to the page; broad terms should point to onboarding pages first.
- Use `boost` sparingly. Prefer `getting-started` and practical guides over reference pages for beginner queries.
- Stellar pages should include both protocol names and likely user terms, such as `Soroban`, `Stellar smart contract`, `friendbot`, and `testnet faucet`.
- Re-run the manual checks in `SEARCH_TESTS.md` after changing search metadata.
