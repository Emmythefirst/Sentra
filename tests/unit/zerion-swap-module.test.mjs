import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(__filename)));

describe("Zerion Swap Module Integration", () => {
  let swapModule;

  before(async () => {
    // Ensure ZERION_API_KEY is set
    if (!process.env.ZERION_API_KEY) {
      throw new Error("ZERION_API_KEY environment variable is required");
    }
  });

  it("can dynamically import cli/lib/trading/swap.js", async () => {
    try {
      const swapPath = join(ROOT, "cli/lib/trading/swap.js");
      swapModule = await import(`file://${swapPath}`);
      assert.ok(swapModule, "Module should load");
      console.log("✅ Module imported successfully");
    } catch (err) {
      console.error("❌ Import failed:", err.message);
      throw err;
    }
  });

  it("exports getSwapQuote function", () => {
    assert.ok(swapModule.getSwapQuote, "getSwapQuote should be exported");
    assert.equal(typeof swapModule.getSwapQuote, "function", "getSwapQuote should be a function");
    console.log("✅ getSwapQuote function found");
  });

  it("getSwapQuote returns expected quote structure", async function() {
    this.timeout(10000); // API call may take time

    try {
      const quote = await swapModule.getSwapQuote({
        fromToken: "USDC",
        toToken: "SOL",
        amount: "1",
        fromChain: "solana",
        toChain: "solana",
        walletAddress: "So11111111111111111111111111111111111111112", // SOL token address as test wallet
      });

      assert.ok(quote, "Quote should exist");
      assert.ok(quote.transaction, "Quote should have transaction field");
      assert.ok(quote.transaction.data, "Transaction should have data field");
      assert.equal(typeof quote.transaction.data, "string", "Transaction data should be a string");
      
      // Verify it looks like hex data (0x prefix or just hex chars)
      const isHex = /^[0-9a-fA-F]*$/.test(quote.transaction.data) || /^0x[0-9a-fA-F]*$/.test(quote.transaction.data);
      assert.ok(isHex, "Transaction data should be hex-encoded");

      console.log("✅ Quote structure is valid");
      console.log(`   - From: ${quote.from?.symbol || 'unknown'}`);
      console.log(`   - To: ${quote.to?.symbol || 'unknown'}`);
      console.log(`   - Estimated output: ${quote.estimatedOutput || 'N/A'}`);
      console.log(`   - Transaction data length: ${quote.transaction.data.length} chars`);
      console.log(`   - Liquidity source: ${quote.liquiditySource || 'N/A'}`);
    } catch (err) {
      console.error("❌ Quote request failed:", err.message);
      throw err;
    }
  });

  it("transaction.data can be deserialized as Solana transaction", async function() {
    this.timeout(10000);

    try {
      const { VersionedTransaction, Transaction } = await import("@solana/web3.js");

      const quote = await swapModule.getSwapQuote({
        fromToken: "USDC",
        toToken: "SOL",
        amount: "1",
        fromChain: "solana",
        toChain: "solana",
        walletAddress: "So11111111111111111111111111111111111111112",
      });

      const txData = quote.transaction.data;
      assert.ok(txData, "Transaction data should exist");

      const txBuffer = Buffer.from(txData, "hex");
      assert.ok(txBuffer.length > 0, "Transaction buffer should have content");

      // Try to deserialize as VersionedTransaction, fall back to legacy
      let deserialized = false;
      try {
        const versionedTx = VersionedTransaction.deserialize(txBuffer);
        assert.ok(versionedTx, "Should deserialize as VersionedTransaction");
        deserialized = true;
        console.log("✅ Transaction deserialized as VersionedTransaction");
      } catch {
        const legacyTx = Transaction.from(txBuffer);
        assert.ok(legacyTx, "Should deserialize as legacy Transaction");
        deserialized = true;
        console.log("✅ Transaction deserialized as legacy Transaction");
      }

      assert.ok(deserialized, "Transaction should deserialize to either format");
    } catch (err) {
      console.error("❌ Transaction deserialization test failed:", err.message);
      throw err;
    }
  });
});
