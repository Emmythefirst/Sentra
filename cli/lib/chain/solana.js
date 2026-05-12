/**
 * Solana transaction building, signing (via OWS), and RPC broadcast.
 */

import {
  Connection,
  sendAndConfirmRawTransaction,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import { getSolanaRpcUrl } from "./registry.js";
import * as ows from "../wallet/keystore.js";

let _connection;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(getSolanaRpcUrl(), "confirmed");
  }
  return _connection;
}

/**
 * Sign and broadcast a Solana transaction from the Zerion swap API.
 *
 * The Zerion API returns transaction data as a hex-encoded serialized
 * Solana transaction. We deserialize it, sign with OWS, and broadcast.
 */
export async function signAndBroadcastSolana(swapTxData, walletName, passphrase) {
  const connection = getConnection();

  // New API format: transaction_swap.solana.raw = base64 serialized VersionedTransaction
  // Legacy format: transaction.data = hex
  const rawBase64 = swapTxData.raw;
  const rawHex = swapTxData.data;

  if (!rawBase64 && !rawHex) {
    throw new Error("No transaction data from swap API for Solana");
  }

  // Get raw transaction bytes
  const txBytes = rawBase64
    ? Buffer.from(rawBase64, "base64")
    : Buffer.from(rawHex, "hex");

  let signedTxBytes;

  try {
    // OWS signs the transaction and returns a 64-byte ed25519 signature
    // (same pattern as signEvmTransaction which returns r||s, not the full tx).
    // We must inject the signature into the deserialized transaction ourselves.
    const signResult = ows.signSolanaTransaction(walletName, txBytes.toString("hex"), passphrase);
    const signatureBytes = Buffer.from(signResult.signature, "hex");

    // Deserialize the original transaction, inject signature, re-serialize
    const tx = VersionedTransaction.deserialize(txBytes);
    const solAddress = ows.getSolAddress(walletName);
    if (!solAddress) throw new Error(`Wallet "${walletName}" has no Solana address`);
    tx.addSignature(new PublicKey(solAddress), signatureBytes);
    signedTxBytes = Buffer.from(tx.serialize());
  } catch (err) {
    throw new Error(`Failed to sign Solana transaction: ${err.message}`);
  }

  // Broadcast
  const txHash = await sendAndConfirmRawTransaction(connection, signedTxBytes, {
    skipPreflight: false,
    commitment: "confirmed",
  });

  return {
    hash: txHash,
    status: "success",
    chain: "solana",
  };
}
