import { Pool } from "pg";
import type { Block, Transaction, Input, Output } from "./types.js";

export class UTXOManager {
  constructor(private pool: Pool) {}

  async processBlock(block: Block): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Insert block record
      await client.query("INSERT INTO blocks (id, height) VALUES ($1, $2)", [
        block.id,
        block.height,
      ]);

      // Process each transaction
      for (const transaction of block.transactions) {
        await this.processTransaction(client, transaction, block.height);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async processTransaction(
    client: any,
    transaction: Transaction,
    blockHeight: number
  ): Promise<void> {
    // Insert transaction record
    await client.query(
      "INSERT INTO transactions (id, block_id, block_height) VALUES ($1, (SELECT id FROM blocks WHERE height = $2), $2)",
      [transaction.id, blockHeight]
    );

    // Process inputs (mark UTXOs as spent)
    for (const input of transaction.inputs) {
      await this.spendUTXO(client, input, transaction.id);
    }

    // Process outputs (create new UTXOs)
    for (let index = 0; index < transaction.outputs.length; index++) {
      const output = transaction.outputs[index];
      await this.createUTXO(client, transaction.id, index, output, blockHeight);
    }
  }

  private async spendUTXO(
    client: any,
    input: Input,
    spendingTxId: string
  ): Promise<void> {
    // Get the UTXO details before marking as spent
    const utxoResult = await client.query(
      "SELECT address, value FROM utxos WHERE tx_id = $1 AND output_index = $2 AND is_spent = FALSE",
      [input.txId, input.index]
    );

    if (utxoResult.rows.length === 0) {
      throw new Error(
        `UTXO ${input.txId}:${input.index} not found or already spent`
      );
    }

    const { address, value } = utxoResult.rows[0];

    // Mark UTXO as spent
    await client.query(
      "UPDATE utxos SET is_spent = TRUE, spent_in_tx = $1 WHERE tx_id = $2 AND output_index = $3",
      [spendingTxId, input.txId, input.index]
    );

    // Update address balance (subtract spent amount)
    await this.updateAddressBalance(client, address, -parseFloat(value));
  }

  private async createUTXO(
    client: any,
    txId: string,
    index: number,
    output: Output,
    blockHeight: number
  ): Promise<void> {
    // Insert new UTXO
    await client.query(
      "INSERT INTO utxos (tx_id, output_index, address, value, block_height) VALUES ($1, $2, $3, $4, $5)",
      [txId, index, output.address, output.value, blockHeight]
    );

    // Update address balance (add received amount)
    await this.updateAddressBalance(client, output.address, output.value);
  }

  private async updateAddressBalance(
    client: any,
    address: string,
    deltaValue: number
  ): Promise<void> {
    // Upsert address balance
    await client.query(
      `
      INSERT INTO address_balances (address, balance) 
      VALUES ($1, $2) 
      ON CONFLICT (address) 
      DO UPDATE SET balance = address_balances.balance + $2
    `,
      [address, deltaValue]
    );
  }

  async getAddressBalance(address: string): Promise<number> {
    const result = await this.pool.query(
      "SELECT balance FROM address_balances WHERE address = $1",
      [address]
    );

    return parseFloat(result.rows[0]?.balance || 0);
  }

  async rollbackToHeight(targetHeight: number): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Get all blocks that need to be rolled back
      const blocksToRemove = await client.query(
        "SELECT id, height FROM blocks WHERE height > $1 ORDER BY height DESC",
        [targetHeight]
      );

      // For each block to remove (in reverse order)
      for (const block of blocksToRemove.rows) {
        await this.rollbackBlock(client, block.id, block.height);
      }

      // Remove the blocks themselves
      await client.query("DELETE FROM blocks WHERE height > $1", [
        targetHeight,
      ]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollbackBlock(
    client: any,
    blockId: string,
    blockHeight: number
  ): Promise<void> {
    // Get all transactions in this block
    const transactions = await client.query(
      "SELECT id FROM transactions WHERE block_id = $1 ORDER BY id",
      [blockId]
    );

    // For each transaction, reverse its effects
    for (const tx of transactions.rows) {
      await this.rollbackTransaction(client, tx.id);
    }
  }

  private async rollbackTransaction(
    client: any,
    transactionId: string
  ): Promise<void> {
    // First, handle outputs (remove UTXOs created by this transaction)
    const outputs = await client.query(
      "SELECT address, value FROM utxos WHERE tx_id = $1",
      [transactionId]
    );

    for (const output of outputs.rows) {
      // Subtract the value from address balance
      await this.updateAddressBalance(
        client,
        output.address,
        -parseFloat(output.value)
      );
    }

    // Remove the UTXOs
    await client.query("DELETE FROM utxos WHERE tx_id = $1", [transactionId]);

    // Then, handle inputs (unspend UTXOs that were spent by this transaction)
    const spentUTXOs = await client.query(
      "SELECT tx_id, output_index, address, value FROM utxos WHERE spent_in_tx = $1",
      [transactionId]
    );

    for (const utxo of spentUTXOs.rows) {
      // Mark UTXO as unspent
      await client.query(
        "UPDATE utxos SET is_spent = FALSE, spent_in_tx = NULL WHERE tx_id = $1 AND output_index = $2",
        [utxo.tx_id, utxo.output_index]
      );

      // Add the value back to address balance
      await this.updateAddressBalance(
        client,
        utxo.address,
        parseFloat(utxo.value)
      );
    }

    // Remove the transaction
    await client.query("DELETE FROM transactions WHERE id = $1", [
      transactionId,
    ]);
  }
}
