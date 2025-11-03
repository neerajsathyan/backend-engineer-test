import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { createHash } from "crypto";
import { Pool } from "pg";
import { createTables } from "../src/database";
import { UTXOManager } from "../src/utxo";
import { validateBlock } from "../src/validation";
import type { Block, Transaction, Output, Input } from "../src/types";

// Test database connection
let pool: Pool;
let utxoManager: UTXOManager;

beforeAll(async () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    "postgres://myuser:mypassword@localhost:5432/mydatabase";

  pool = new Pool({
    connectionString: databaseUrl,
  });

  await createTables(pool);
  utxoManager = new UTXOManager(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Clean up tables before each test
  await pool.query("DELETE FROM utxos");
  await pool.query("DELETE FROM transactions");
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM address_balances");
});

describe("Block Validation", () => {
  test("should reject invalid block height", async () => {
    const block = createTestBlock(5, []); // Should be 1, not 5
    await expect(validateBlock(pool, block)).rejects.toThrow(
      "Invalid block height"
    );
  });

  test("should validate correct block height", async () => {
    const block = createTestBlock(1, []);
    await expect(validateBlock(pool, block)).resolves.toBeUndefined();
  });

  test("should reject invalid block ID hash", async () => {
    const transactions = [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ];
    const block = createTestBlock(1, transactions);
    block.id = "invalid"; // Wrong hash
    await expect(validateBlock(pool, block)).rejects.toThrow(
      "Invalid block ID"
    );
  });

  test("should validate correct block ID hash", async () => {
    const transactions = [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ];
    const block = createTestBlock(1, transactions);
    await expect(validateBlock(pool, block)).resolves.toBeUndefined();
  });

  test("should validate transaction input/output balance", async () => {
    // First create a block with initial UTXO
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ]);
    await utxoManager.processBlock(block1);

    // Create second block that spends the UTXO correctly
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 6 },
          { address: "addr3", value: 4 },
        ]
      ),
    ]);

    await expect(validateBlock(pool, block2)).resolves.toBeUndefined();
  });

  test("should reject transaction with mismatched input/output values", async () => {
    // First create a block with initial UTXO
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ]);
    await utxoManager.processBlock(block1);

    // Create invalid second block (outputs don't equal inputs)
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 6 },
          { address: "addr3", value: 5 }, // 6 + 5 = 11, but input is 10
        ]
      ),
    ]);

    await expect(validateBlock(pool, block2)).rejects.toThrow("input sum");
  });
});

describe("UTXO Management", () => {
  test("should process genesis block of the blockchain correctly", async () => {
    const block = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ]);

    await utxoManager.processBlock(block);

    const balance = await utxoManager.getAddressBalance("addr1");
    expect(balance).toBe(10);
  });

  test("should handle spending UTXOs correctly", async () => {
    // Genesis block
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 10 }]),
    ]);
    await utxoManager.processBlock(block1);

    // Spending block
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 6 },
          { address: "addr3", value: 4 },
        ]
      ),
    ]);
    await utxoManager.processBlock(block2);

    expect(await utxoManager.getAddressBalance("addr1")).toBe(0);
    expect(await utxoManager.getAddressBalance("addr2")).toBe(6);
    expect(await utxoManager.getAddressBalance("addr3")).toBe(4);
  });

  test("should handle complex transaction chains", async () => {
    // Block 1: Initial distribution
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 100 }]),
    ]);
    await utxoManager.processBlock(block1);

    // Block 2: Split the UTXO
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 30 },
          { address: "addr3", value: 70 },
        ]
      ),
    ]);
    await utxoManager.processBlock(block2);

    // Block 3: Further transactions
    const block3 = createTestBlock(3, [
      createTestTransaction(
        "tx3",
        [{ txId: "tx2", index: 1 }],
        [
          { address: "addr4", value: 25 },
          { address: "addr5", value: 45 },
        ]
      ),
    ]);
    await utxoManager.processBlock(block3);

    expect(await utxoManager.getAddressBalance("addr1")).toBe(0);
    expect(await utxoManager.getAddressBalance("addr2")).toBe(30);
    expect(await utxoManager.getAddressBalance("addr3")).toBe(0);
    expect(await utxoManager.getAddressBalance("addr4")).toBe(25);
    expect(await utxoManager.getAddressBalance("addr5")).toBe(45);
  });
});

describe("Rollback Functionality", () => {
  test("should rollback to previous height correctly", async () => {
    // Create multiple blocks
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 100 }]),
    ]);
    await utxoManager.processBlock(block1);

    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 40 },
          { address: "addr3", value: 60 },
        ]
      ),
    ]);
    await utxoManager.processBlock(block2);

    const block3 = createTestBlock(3, [
      createTestTransaction(
        "tx3",
        [{ txId: "tx2", index: 0 }],
        [{ address: "addr4", value: 40 }]
      ),
    ]);
    await utxoManager.processBlock(block3);

    // Rollback to height 2
    await utxoManager.rollbackToHeight(2);

    // Check balances are restored to height 2 state
    expect(await utxoManager.getAddressBalance("addr1")).toBe(0);
    expect(await utxoManager.getAddressBalance("addr2")).toBe(40);
    expect(await utxoManager.getAddressBalance("addr3")).toBe(60);
    expect(await utxoManager.getAddressBalance("addr4")).toBe(0);
  });

  test("should rollback to genesis block correctly", async () => {
    // Create multiple blocks
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 50 }]),
    ]);
    await utxoManager.processBlock(block1);

    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [{ address: "addr2", value: 50 }]
      ),
    ]);
    await utxoManager.processBlock(block2);

    // Rollback to height 1
    await utxoManager.rollbackToHeight(1);

    expect(await utxoManager.getAddressBalance("addr1")).toBe(50);
    expect(await utxoManager.getAddressBalance("addr2")).toBe(0);
  });

  test("should handle rollback to height 0 (complete reset)", async () => {
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 50 }]),
    ]);
    await utxoManager.processBlock(block1);

    await utxoManager.rollbackToHeight(0);

    expect(await utxoManager.getAddressBalance("addr1")).toBe(0);
  });
});

describe("Edge Cases", () => {
  test("should handle addresses with no transactions", async () => {
    const balance = await utxoManager.getAddressBalance("nonexistent-address");
    expect(balance).toBe(0);
  });

  test("should handle multiple outputs to same address", async () => {
    const block = createTestBlock(1, [
      createTestTransaction(
        "tx1",
        [],
        [
          { address: "addr1", value: 30 },
          { address: "addr1", value: 20 },
        ]
      ),
    ]);

    await utxoManager.processBlock(block);
    expect(await utxoManager.getAddressBalance("addr1")).toBe(50);
  });

  test("should reject spending non-existent UTXO", async () => {
    const block = createTestBlock(1, [
      createTestTransaction(
        "tx1",
        [{ txId: "nonexistent", index: 0 }],
        [{ address: "addr1", value: 10 }]
      ),
    ]);

    await expect(validateBlock(pool, block)).rejects.toThrow("not found");
  });
});

// Helper functions
function createTestBlock(height: number, transactions: Transaction[]): Block {
  const transactionIds = transactions.map((tx) => tx.id).sort();
  const hashInput = height + transactionIds.join("");
  const id = createHash("sha256").update(hashInput).digest("hex");

  return {
    id,
    height,
    transactions,
  };
}

function createTestTransaction(
  id: string,
  inputs: Input[],
  outputs: Output[]
): Transaction {
  return {
    id,
    inputs,
    outputs,
  };
}
