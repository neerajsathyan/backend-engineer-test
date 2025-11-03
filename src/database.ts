import { Pool } from "pg";

export async function createTables(pool: Pool): Promise<void> {
  // block information
  await pool.query(`
        CREATE TABLE IF NOT EXISTS blocks (
            id VARCHAR(64) PRIMARY KEY,
            height INTEGER UNIQUE NOT NULL
        );  
    `);

  // transactions
  await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id VARCHAR(64) PRIMARY KEY,
            block_id VARCHAR(64) NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            block_height INTEGER NOT NULL
        );  
    `);

  // utxo
  await pool.query(`
        CREATE TABLE IF NOT EXISTS utxos (
            tx_id VARCHAR(64) NOT NULL,
            output_index INTEGER NOT NULL,
            address VARCHAR(128) NOT NULL,
            value BIGINT NOT NULL,
            is_spent BOOLEAN DEFAULT FALSE,
            spent_in_tx VARCHAR(64),
            block_height INTEGER NOT NULL,
            PRIMARY KEY (tx_id, output_index),
            FOREIGN KEY (tx_id) REFERENCES transactions(id) ON DELETE CASCADE
        );  
    `);

  // address balances
  await pool.query(`
        CREATE TABLE IF NOT EXISTS address_balances (
            address VARCHAR(128) PRIMARY KEY,
            balance BIGINT NOT NULL DEFAULT 0
        );  
    `);

  console.log("Database tables created successfully.");
}

export async function getAddressBalance(
  pool: Pool,
  address: string
): Promise<number> {
  const result = await pool.query(
    "SELECT balance FROM address_balances WHERE address = $1",
    [address]
  );

  if (result.rows.length === 0) {
    return 0;
  }
  return parseFloat(result.rows[0].balance);
}
