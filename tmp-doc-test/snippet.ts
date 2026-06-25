// @ts-nocheck
// snippet 0
import { Asset, Networks } from "@stellar/stellar-sdk";
import { buildStellarSwapAndStealth } from "@wraith-protocol/sdk/chains/stellar";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const txData = buildStellarSwapAndStealth({
  recipientMetaAddress: "st:xlm:abcdef123456...",
  sourceAsset: new Asset("USDC", USDC_ISSUER),
  destinationAsset: Asset.native(),
  destinationAmount: "8.5",
  maxSlippageBps: 50,
  networkPassphrase: Networks.TESTNET,
});

const signedTx = await signTransactionWithSenderWallet(txData.transaction);
await submitTransaction(signedTx);

console.log("Stealth address:", txData.stealthAddress);
console.log("View tag:", txData.viewTag);

// snippet 1
import { Asset, Horizon } from "@stellar/stellar-sdk";

const server = new Horizon.Server("https://horizon-testnet.stellar.org");
const usdc = new Asset("USDC", USDC_ISSUER);

const paths = await server
  .strictReceivePaths([usdc], Asset.native(), "8.5")
  .call();

if (paths.records.length === 0) {
  throw new Error("No USDC→XLM liquidity path available for 8.5 XLM");
}

const bestPath = paths.records[0];
const requiredUsdc = parseFloat(bestPath.source_amount);
if (requiredUsdc > 20) {
  throw new Error(`Swap would cost ${requiredUsdc} USDC, which exceeds budget`);
}

// snippet 2
import {
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  Horizon,
  TransactionBuilder,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import {
  decodeStealthMetaAddress,
  generateStealthAddress,
  getDeployment,
  SCHEME_ID,
} from "@wraith-protocol/sdk/chains/stellar";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NETWORK = Networks.TESTNET;
const HORIZON = "https://horizon-testnet.stellar.org";

const senderKeypair = Keypair.fromSecret(process.env.SENDER_SECRET!);
const recipientMetaAddress = "st:xlm:abcdef123456...";
const usdcAsset = new Asset("USDC", USDC_ISSUER);

const server = new Horizon.Server(HORIZON);
const sorobanServer = new rpc.Server(HORIZON);
const deployment = getDeployment("stellar");

const { spendingPubKey, viewingPubKey } = decodeStealthMetaAddress(recipientMetaAddress);
const stealth = generateStealthAddress(spendingPubKey, viewingPubKey);

const pathResult = await server
  .strictReceivePaths([usdcAsset], Asset.native(), "8.5")
  .call();

if (pathResult.records.length === 0) {
  throw new Error("No USDC→XLM path available");
}

const bestPath = pathResult.records[0];
const sendMax = parseFloat(bestPath.source_amount) * 1.01;

const senderAccount = await server.loadAccount(senderKeypair.publicKey());
const announcer = new Contract(deployment.contracts.announcer);

const metadata = new Uint8Array([stealth.viewTag]);
const tx = new TransactionBuilder(senderAccount, {
  fee: "1000000",
  networkPassphrase: NETWORK,
})
  .addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: usdcAsset,
      sendMax: sendMax.toFixed(7),
      destination: stealth.stealthAddress,
      destAsset: Asset.native(),
      destAmount: "8.5",
      path: [],
    }),
  )
  .addOperation(
    announcer.call(
      "announce",
      xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeAccount(
          xdr.AccountId.publicKeyTypeEd25519(
            senderKeypair.rawPublicKey(),
          ),
        ),
      ),
      xdr.ScVal.scvU32(SCHEME_ID),
      xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeAccount(
          xdr.AccountId.publicKeyTypeEd25519(
            Keypair.fromPublicKey(stealth.stealthAddress).rawPublicKey(),
          ),
        ),
      ),
      xdr.ScVal.scvBytes(Buffer.from(stealth.ephemeralPubKey)),
      xdr.ScVal.scvBytes(Buffer.from(metadata)),
    ),
  )
  .setTimeout(30)
  .build();

const simulation = await sorobanServer.simulateTransaction(tx);
if (!rpc.Api.isSimulationSuccess(simulation)) {
  throw new Error("Simulation failed — check path or contract call parameters");
}

const signedTx = tx;
signedTx.sign(senderKeypair);

const result = await sorobanServer.sendTransaction(signedTx);
console.log("Transaction hash:", result.hash);
console.log("Stealth address:", stealth.stealthAddress);
console.log("Stealth view tag:", stealth.viewTag);

