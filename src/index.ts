import Fastify from "fastify";
import { Pool } from "pg";
import { createTables } from "./database";
import { UTXOManager } from "./utxo";
import {
  validateBlock,
  validateRollbackHeight,
  ValidationError,
} from "./validation";
import type { Block, BalanceResponse, ErrorResponse } from "./types";

const fastify = Fastify({ logger: true });

let pool: Pool;
let utxoManager: UTXOManager;

fastify.get("/", async (request, reply) => {
  return { status: "ok", message: "Blockchain Indexer API" };
});

// POST /blocks endpoint to process a new block
fastify.post<{ Body: Block; Reply: { success: boolean } | ErrorResponse }>(
  "/blocks",
  async (request, reply) => {
    const block = request.body;

    try {
      // Validate the block
      await validateBlock(pool, block);
      // Process the block
      await utxoManager.processBlock(block);
      return { success: true };
    } catch (error) {
      if (error instanceof ValidationError) {
        reply.status(400);
        return { error: "Validation Error", message: error.message };
      }
      reply.status(500);
      return {
        error: "Internal Server Error",
        message: "An unexpected error occurred.",
      };
    }
  }
);

// GET /balance/:address endpoint to get address balance
fastify.get<{
  Params: { address: string };
  Reply: BalanceResponse | ErrorResponse;
}>("/balance/:address", async (request, reply) => {
  const { address } = request.params;
  if (!address || typeof address !== "string") {
    reply.status(400);
    return {
      error: "Invalid Address",
      message: "Address parameter is required and must be a string.",
    };
  }
  try {
    const balance = await utxoManager.getAddressBalance(address);
    return { address, balance };
  } catch (error) {
    reply.status(500);
    return {
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
    };
  }
});

// POST /rollback?height=number endpoint to rollback to a specific block height
fastify.post<{
  Querystring: { height: string };
  Reply: { success: boolean } | ErrorResponse;
}>("/rollback", async (request, reply) => {
  const { height } = request.query;

  // Validate height parameter exists and can be parsed as a number
  if (!height) {
    reply.status(400);
    return {
      error: "Bad Request",
      message: "Height parameter is required.",
    };
  }

  const heightNum = parseInt(height, 10);
  if (isNaN(heightNum) || heightNum < 0) {
    reply.status(400);
    return {
      error: "Bad Request",
      message: "Height parameter must be a non-negative number.",
    };
  }

  try {
    // Validate the rollback height
    await validateRollbackHeight(pool, heightNum);
    // Rollback the blockchain state
    await utxoManager.rollbackToHeight(heightNum);
    return { success: true };
  } catch (error) {
    if (error instanceof ValidationError) {
      reply.status(400);
      return { error: "Validation Error", message: error.message };
    }
    reply.status(500);
    return {
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
    };
  }
});

async function startServer() {
  try {
    // Initialize database tables
    const databaseUrl =
      process.env.DATABASE_URL ||
      "postgres://myuser:mypassword@localhost:5432/mydatabase";
    pool = new Pool({
      connectionString: databaseUrl,
    });
    await pool.connect();
    await createTables(pool);
    utxoManager = new UTXOManager(pool);
    console.log("Database connected and tables created. Server is starting...");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  await fastify.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down server...");
  await fastify.close();
  await pool.end();
  process.exit(0);
});

startServer().then(() => {
  fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
    fastify.log.info(`Server listening at ${address}`);
  });
});
