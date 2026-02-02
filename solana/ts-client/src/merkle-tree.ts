// Poseidon2 Merkle Tree implementation matching the circuit's tree structure
// Uses circomlibjs for Poseidon hashing (Circom-compatible, same as Solana's sol_poseidon syscall)
import { buildPoseidon, type Poseidon } from "circomlibjs";

// Global poseidon instance (initialized lazily)
let poseidonInstance: Poseidon | null = null;

/** Initialize the Poseidon hasher (must be called before using hash functions) */
export async function initPoseidon(): Promise<void> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
}

/** Get the initialized Poseidon instance */
function getPoseidon(): Poseidon {
  if (!poseidonInstance) {
    throw new Error("Poseidon not initialized. Call initPoseidon() first.");
  }
  return poseidonInstance;
}

/** Poseidon hash of two Field elements (Circom-compatible) - matches circuit's poseidon_hash_2() */
function poseidonHash2(left: bigint, right: bigint): bigint {
  const poseidon = getPoseidon();
  const hash = poseidon([left, right]);
  return poseidon.F.toObject(hash) as bigint;
}

/** Convert hex string (with or without 0x prefix) to bigint */
function hexToBigint(hex: string): bigint {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + cleaned);
}

/** Convert bigint to 0x-prefixed hex string (64 chars) */
function bigintToHex(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

const ZERO_VALUES = [
  "0x0d823319708ab99ec915efd4f7e03d11ca1790918e8f04cd14100aceca2aa9ff",
  "0x170a9598425eb05eb8dc06986c6afc717811e874326a79576c02d338bdf14f13",
  "0x273b1a40397b618dac2fc66ceb71399a3e1a60341e546e053cbfa5995e824caf",
  "0x16bf9b1fb2dfa9d88cfb1752d6937a1594d257c2053dff3cb971016bfcffe2a1",
  "0x1288271e1f93a29fa6e748b7468a77a9b8fc3db6b216ce5fc2601fc3e9bd6b36",
  "0x1d47548adec1068354d163be4ffa348ca89f079b039c9191378584abd79edeca",
  "0x0b98a89e6827ef697b8fb2e280a2342d61db1eb5efc229f5f4a77fb333b80bef",
  "0x231555e37e6b206f43fdcd4d660c47442d76aab1ef552aef6db45f3f9cf2e955",
  "0x03d0dc8c92e2844abcc5fdefe8cb67d93034de0862943990b09c6b8e3fa27a86",
  "0x1d51ac275f47f10e592b8e690fd3b28a76106893ac3e60cd7b2a3a443f4e8355",
  "0x16b671eb844a8e4e463e820e26560357edee4ecfdbf5d7b0a28799911505088d",
  "0x115ea0c2f132c5914d5bb737af6eed04115a3896f0d65e12e761ca560083da15",
  "0x139a5b42099806c76efb52da0ec1dde06a836bf6f87ef7ab4bac7d00637e28f0",
  "0x0804853482335a6533eb6a4ddfc215a08026db413d247a7695e807e38debea8e",
  "0x2f0b264ab5f5630b591af93d93ec2dfed28eef017b251e40905cdf7983689803",
  "0x170fc161bf1b9610bf196c173bdae82c4adfd93888dc317f5010822a3ba9ebee",
  "0x0b2e7665b17622cc0243b6fa35110aa7dd0ee3cc9409650172aa786ca5971439",
  "0x12d5a033cbeff854c5ba0c5628ac4628104be6ab370699a1b2b4209e518b0ac5",
  "0x1bc59846eb7eafafc85ba9a99a89562763735322e4255b7c1788a8fe8b90bf5d",
  "0x1b9421fbd79f6972a348a3dd4721781ec25a5d8d27342942ae00aba80a3904d4",
];

async function hashLeftRight(left: string, right: string): Promise<string> {
  const leftBigint = hexToBigint(left);
  const rightBigint = hexToBigint(right);
  const hash = poseidonHash2(leftBigint, rightBigint);
  return bigintToHex(hash);
}

export interface MerkleProof {
  root: string;
  pathElements: string[];
  pathIndices: number[];
  leaf: string;
}

export class PoseidonTree {
  private storage: Map<string, string> = new Map();
  private zeros: string[];
  private levels: number;
  private totalLeaves: number = 0;

  constructor(levels: number, zeros: string[]) {
    this.levels = levels;
    this.zeros = zeros;
  }

  async insert(leaf: string): Promise<void> {
    const index = this.totalLeaves;
    await this.update(index, leaf, true);
    this.totalLeaves++;
  }

  private async update(
    index: number,
    newLeaf: string,
    isInsert: boolean
  ): Promise<void> {
    if (!isInsert && index >= this.totalLeaves) {
      throw Error("Use insert method for new elements.");
    }

    let currentElement = newLeaf;
    let currentIndex = index;

    for (let level = 0; level < this.levels; level++) {
      const key = `${level}-${currentIndex}`;
      this.storage.set(key, currentElement);

      const siblingIndex =
        currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      const siblingKey = `${level}-${siblingIndex}`;
      const sibling =
        this.storage.get(siblingKey) || this.zeros[level];

      const [left, right] =
        currentIndex % 2 === 0
          ? [currentElement, sibling]
          : [sibling, currentElement];

      currentElement = await hashLeftRight(left, right);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.storage.set(`${this.levels}-0`, currentElement);
  }

  root(): string {
    return (
      this.storage.get(`${this.levels}-0`) || this.zeros[this.levels]
    );
  }

  proof(index: number): MerkleProof {
    const leaf = this.storage.get(`0-${index}`);
    if (!leaf) throw new Error("leaf not found");

    const pathElements: string[] = [];
    const pathIndices: number[] = [];

    let currentIndex = index;
    for (let level = 0; level < this.levels; level++) {
      const siblingIndex =
        currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      const sibling =
        this.storage.get(`${level}-${siblingIndex}`) || this.zeros[level];
      pathElements.push(sibling);
      pathIndices.push(currentIndex % 2);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      root: this.root(),
      pathElements,
      pathIndices,
      leaf,
    };
  }

  getIndex(leaf: string): number {
    for (const [key, value] of this.storage.entries()) {
      if (value === leaf && key.startsWith("0-")) {
        return parseInt(key.split("-")[1]);
      }
    }
    return -1;
  }
}

export function createPoseidonTree(levels: number = 20): PoseidonTree {
  return new PoseidonTree(levels, ZERO_VALUES);
}
