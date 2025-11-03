import { describe, test, expect, beforeEach } from "bun:test";
import { createHash } from "crypto";
import type { Block, Transaction, Input, Output } from "../src/types";

// Test the API endpoints using fetch
const API_BASE = "http://localhost:3000";

describe("API Endpoints Integration Tests", () => {
  beforeEach(async () => {
    // Clean state by rolling back to height 0
    try {
      await fetch(`${API_BASE}/rollback?height=0`, { method: "POST" });
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  });

  test("should return health status", async () => {
    const response = await fetch(`${API_BASE}/`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
  });

  test("should process valid genesis block", async () => {
    const block = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 100 }]),
    ]);

    const response = await fetch(`${API_BASE}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(block),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  test("should reject block with wrong height", async () => {
    const block = createTestBlock(5, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 100 }]),
    ]);

    const response = await fetch(`${API_BASE}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(block),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Validation Error");
  });

  test("should get address balance", async () => {
    // First add a block
    const block = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "test-addr", value: 50 }]),
    ]);

    const postResponse = await fetch(`${API_BASE}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(block),
    });

    expect(postResponse.status).toBe(200);

    // Then check balance
    const response = await fetch(`${API_BASE}/balance/test-addr`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.address).toBe("test-addr");
    expect(data.balance).toBe(50);
  });

  test("should return zero balance for unknown address", async () => {
    const response = await fetch(`${API_BASE}/balance/unknown-address`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.balance).toBe(0);
  });

  test("should handle rollback correctly", async () => {
    // Add two blocks
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "addr1", value: 100 }]),
    ]);
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "addr2", value: 60 },
          { address: "addr3", value: 40 },
        ]
      ),
    ]);

    const block1Response = await fetch(`${API_BASE}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(block1),
    });
    expect(block1Response.status).toBe(200);

    const block2Response = await fetch(`${API_BASE}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(block2),
    });
    expect(block2Response.status).toBe(200);

    // Rollback to height 1
    const rollbackResponse = await fetch(`${API_BASE}/rollback?height=1`, {
      method: "POST",
    });

    expect(rollbackResponse.status).toBe(200);

    // Check balances are restored
    const addr1Response = await fetch(`${API_BASE}/balance/addr1`);
    const addr1Data = await addr1Response.json();
    expect(addr1Data.balance).toBe(100);

    const addr2Response = await fetch(`${API_BASE}/balance/addr2`);
    const addr2Data = await addr2Response.json();
    expect(addr2Data.balance).toBe(0);
  });

  test("should reject rollback with invalid height parameter", async () => {
    const response = await fetch(`${API_BASE}/rollback?height=invalid`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Bad Request");
  });

  test("should reject rollback without height parameter", async () => {
    const response = await fetch(`${API_BASE}/rollback`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Bad Request");
  });

  test("should process complex transaction chain", async () => {
    // Genesis block
    const block1 = createTestBlock(1, [
      createTestTransaction("tx1", [], [{ address: "genesis", value: 1000 }]),
    ]);

    // Split transaction
    const block2 = createTestBlock(2, [
      createTestTransaction(
        "tx2",
        [{ txId: "tx1", index: 0 }],
        [
          { address: "alpha", value: 300 },
          { address: "beta", value: 400 },
          { address: "charlie", value: 300 },
        ]
      ),
    ]);

    // alpha sends to delta
    const block3 = createTestBlock(3, [
      createTestTransaction(
        "tx3",
        [{ txId: "tx2", index: 0 }],
        [
          { address: "delta", value: 150 },
          { address: "alpha", value: 150 },
        ]
      ),
    ]);

    // Process all blocks
    for (const block of [block1, block2, block3]) {
      const response = await fetch(`${API_BASE}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(block),
      });
      console.log(response);
      expect(response.status).toBe(200);
    }

    // Verify final balances
    const genesisBalance = await getBalance("genesis");
    const alphaBalance = await getBalance("alpha");
    const betaBalance = await getBalance("beta");
    const charlieBalance = await getBalance("charlie");
    const deltaBalance = await getBalance("delta");

    expect(genesisBalance).toBe(0);
    expect(alphaBalance).toBe(150);
    expect(betaBalance).toBe(400);
    expect(charlieBalance).toBe(300);
    expect(deltaBalance).toBe(150);
  });
});

// Helper functions
async function getBalance(address: string): Promise<number> {
  const response = await fetch(`${API_BASE}/balance/${address}`);
  const data = await response.json();
  return data.balance;
}

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
