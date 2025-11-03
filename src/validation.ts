import { createHash } from "crypto";
import { Pool } from "pg";
import type { Block, Transaction, Input } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function validateBlock(pool: Pool, block: Block): Promise<void> {
  // Validate height is exactly one unit higher than current height
  await validateBlockHeight(pool, block.height);

  // Validate block ID hash
  validateBlockId(block);

  // Validate all transactions in the block
  for (const transaction of block.transactions) {
    await validateTransaction(pool, transaction);
  }
}

async function validateBlockHeight(pool: Pool, height: number): Promise<void> {
  const result = await pool.query(
    "SELECT MAX(height) as max_height FROM blocks"
  );
  const currentHeight = result.rows[0].max_height || 0;

  const expectedHeight = currentHeight + 1;

  if (height !== expectedHeight) {
    throw new ValidationError(
      `Invalid block height. Expected ${expectedHeight}, got ${height}`
    );
  }
}

function validateBlockId(block: Block): void {
  // Calculate expected hash: sha256(height + transaction1.id + transaction2.id + ... + transactionN.id)
  const transactionIds = block.transactions.map((tx) => tx.id).sort();
  const hashInput = block.height + transactionIds.join("");
  const expectedId = createHash("sha256").update(hashInput).digest("hex");

  if (block.id !== expectedId) {
    throw new ValidationError(
      `Invalid block ID. Expected ${expectedId}, got ${block.id}`
    );
  }
}

async function validateTransaction(
  pool: Pool,
  transaction: Transaction
): Promise<void> {
  const inputValues: number[] = [];
  const outputValues: number[] = [];

  // Calculate total input values
  for (const input of transaction.inputs) {
    const inputValue = await getInputValue(pool, input);
    inputValues.push(inputValue);
  }

  // Calculate total output values
  for (const output of transaction.outputs) {
    outputValues.push(output.value);
  }

  const totalInputs = inputValues.reduce((sum, value) => sum + value, 0);
  const totalOutputs = outputValues.reduce((sum, value) => sum + value, 0);

  if (transaction.inputs.length === 0) {
    return;
  }

  if (totalInputs !== totalOutputs) {
    throw new ValidationError(
      `Transaction ${transaction.id} is invalid: input sum (${totalInputs}) does not equal output sum (${totalOutputs})`
    );
  }
}

async function getInputValue(pool: Pool, input: Input): Promise<number> {
  const result = await pool.query(
    "SELECT value FROM utxos WHERE tx_id = $1 AND output_index = $2 AND is_spent = FALSE",
    [input.txId, input.index]
  );

  if (result.rows.length === 0) {
    throw new ValidationError(
      `Referenced input ${input.txId}:${input.index} not found or already spent`
    );
  }

  return parseFloat(result.rows[0].value);
}

export async function validateRollbackHeight(
  pool: Pool,
  targetHeight: number
): Promise<void> {
  const result = await pool.query(
    "SELECT MAX(height) as max_height FROM blocks"
  );
  const currentHeight = result.rows[0].max_height || 0;

  if (targetHeight < 0) {
    throw new ValidationError("Rollback height cannot be negative");
  }

  if (targetHeight > currentHeight) {
    throw new ValidationError(
      `Cannot rollback to height ${targetHeight} which is higher than current height ${currentHeight}`
    );
  }
}
