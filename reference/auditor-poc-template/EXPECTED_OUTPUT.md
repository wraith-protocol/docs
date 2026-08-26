# Expected Output

A successful run prints two distinct stealth addresses and two distinct
ephemeral public keys, with `ephemeralReused` set to `false`.

```
stealthAddress#1 GABCDEFG...
ephemeralPubKey#1 AAAA...
stealthAddress#2 GHIJKLMN...
ephemeralPubKey#2 BBBB...
ephemeralReused false
```

If `ephemeralReused` is `true`, the SDK has reused an ephemeral key — this is
the privacy-breaking condition described in threat-model `R-01`. A finding that
demonstrates reuse (or any other impacted invariant) should record the exact
output here, plus the transaction hash or on-chain state that proves impact.
