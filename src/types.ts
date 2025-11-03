export interface Output {
  address: string;
  value: number;
}

export interface Input {
  txId: string;
  index: number;
}

export interface Transaction {
  id: string;
  inputs: Array<Input>;
  outputs: Array<Output>;
}

export interface Block {
  id: string;
  height: number;
  transactions: Array<Transaction>;
}

export interface UTXORecord {
  txId: string;
  index: number;
  address: string;
  value: number;
  isSpent: boolean;
  spentInTx?: string;
  blockHeight: number;
}

export interface AddressBalance {
  address: string;
  balance: number;
}

export interface BlockRecord {
  id: string;
  height: number;
  createdAt: Date;
}

export interface BalanceResponse {
  address: string;
  balance: number;
}

export interface ErrorResponse {
  error: string;
  message: string;
}
