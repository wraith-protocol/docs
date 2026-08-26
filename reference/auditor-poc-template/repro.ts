import { Wraith, Chain } from "@wraith-protocol/sdk";

// Replace with the component under test. This template demonstrates the
// structure only — adapt it to the specific finding you are reproducing.
const wraith = new Wraith({
  chain: Chain.Stellar,
  network: "testnet",
  apiKey: process.env.WRAITH_API_KEY,
});

async function main() {
  const { metaAddress } = await wraith.generateStealthKeys();
  const first = await wraith.generateStealthAddress(metaAddress);
  const second = await wraith.generateStealthAddress(metaAddress);

  // A correct SDK never reuses the ephemeral key (threat-model R-01).
  // Surface both values so a reviewer can confirm they differ.
  console.log("stealthAddress#1", first.stealthAddress);
  console.log("ephemeralPubKey#1", first.ephemeralPubKey);
  console.log("stealthAddress#2", second.stealthAddress);
  console.log("ephemeralPubKey#2", second.ephemeralPubKey);
  console.log(
    "ephemeralReused",
    first.ephemeralPubKey === second.ephemeralPubKey,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
