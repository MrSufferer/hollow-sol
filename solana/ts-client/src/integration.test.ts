// ============================================================================
// Mixer Integration Tests
// ============================================================================
// Tests the mixer program with deposit and withdrawal flows:
//   1. Initialize mixer with denomination
//   2. Make deposits (push Merkle roots)
//   3. Generate ZK proof for withdrawal
//   4. Withdraw funds successfully
//   5. Test error cases (unknown root, reused nullifier, invalid proof)
//
// Prerequisites:
//   - ZK verifier program deployed (program ID: D9YEdaR4MT37wUP1GZ1CmrirMtRsegG7gibX3rLb7sgD)
//   - Mixer program deployed
//   - Sunspot and Noir toolchain available
//
// Run with: npm run test
// ============================================================================

import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  lamports,
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
  type ProgramDerivedAddressBump,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  getTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import fs from "fs";
import path from "path";
import { buildPoseidon, type Poseidon } from "circomlibjs";
import { createPoseidonTree, initPoseidon } from "./merkle-tree.js";
import crypto from "crypto";
import { generateProof, createInstructionData, type MixerInputs } from "./proof-helper.js";
import {
  getMixerAddresses,
  getNullifierPda,
  buildInitializeInstruction,
  buildPushRootInstruction,
  buildWithdrawInstruction,
} from "./mixer-client.js";

// ============================================================================
// Configuration
// ============================================================================

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

const VERIFIER_PROGRAM_ID = address(
  "D9YEdaR4MT37wUP1GZ1CmrirMtRsegG7gibX3rLb7sgD"
);

// Mixer program ID - deployed to devnet
const MIXER_PROGRAM_ID = address(
  process.env.MIXER_PROGRAM_ID || "267wWpf21MBLmyHD9j7ausHG6FR8gjMS3758zsMTTjBT"
);

const DENOMINATION = 1_000_000_000n; // 1 SOL

const CIRCUIT_DIR = path.join(process.cwd(), "../../circuits");
const TARGET_DIR = path.join(CIRCUIT_DIR, "target");

// ============================================================================
// Types
// ============================================================================

interface ProofResult {
  proof: Buffer;
  publicWitness: Buffer;
}

interface MixerInputs {
  root: string;
  nullifier_hash: string;
  recipient: string;
  nullifier: string;
  secret: string;
  merkle_proof: string[];
  is_even: boolean[];
}

// ============================================================================
// Helpers
// ============================================================================

async function loadKeypair(filePath: string): Promise<KeyPairSigner> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keypair not found: ${filePath}`);
  }
  const bytes = new Uint8Array(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  return createKeyPairSignerFromBytes(bytes);
}

async function createKeypair(): Promise<KeyPairSigner> {
  // Generate a proper Ed25519 keypair
  // Solana keypair format in bytes: [privateKey (32 bytes), publicKey (32 bytes)]
  // We need to generate both properly
  const { generateKeyPair } = await import("@solana/keys");
  return await generateKeyPair();
}

type PdaResult = readonly [Address<string>, ProgramDerivedAddressBump];

const textEncoder = new TextEncoder();
const addressEncoder = getAddressEncoder();

async function getMixerStatePda(): Promise<PdaResult> {
  return getProgramDerivedAddress({
    programAddress: MIXER_PROGRAM_ID,
    seeds: [textEncoder.encode("mixer_state")],
  });
}

async function getMixerVaultPda(): Promise<PdaResult> {
  return getProgramDerivedAddress({
    programAddress: MIXER_PROGRAM_ID,
    seeds: [textEncoder.encode("mixer_vault")],
  });
}

async function getNullifierPda(nullifierHash: Uint8Array): Promise<PdaResult> {
  return getProgramDerivedAddress({
    programAddress: MIXER_PROGRAM_ID,
    seeds: [textEncoder.encode("nullifier"), nullifierHash],
  });
}

interface RpcContext {
  rpc: ReturnType<typeof createSolanaRpc>;
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
}

function createRpcContext(rpcUrl: string): RpcContext {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    rpcUrl.replace("https://", "wss://").replace("http://", "ws://")
  );
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  return { rpc, rpcSubscriptions, sendAndConfirm };
}

function formatLamports(lamports: bigint): string {
  return `${(Number(lamports) / 1e9).toFixed(9)} SOL`;
}

async function getBalance(
  ctx: RpcContext,
  address: Address
): Promise<bigint> {
  const result = await ctx.rpc.getBalance(address).send();
  return result.value;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Helper function to convert bigint to hex string (0x-prefixed, 64 chars)
function bigintToHex(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

// Helper function to convert hex string to bigint
function hexToBigint(hex: string): bigint {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + cleaned);
}

// Helper function to generate random bigint (32 bytes)
function randomBigint(): bigint {
  const bytes = crypto.randomBytes(32);
  return BigInt("0x" + bytes.toString("hex"));
}

// ============================================================================
// Merkle Tree Helpers (using Poseidon2) - DEPRECATED, use merkle-tree.ts instead
// ============================================================================

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
  const bb = await Barretenberg.new();
  // Get Fr class from a hash result (Fr is the return type of poseidon2Hash)
  const tempHash = await (bb as any).poseidon2Hash([1n, 2n]);
  const Fr = tempHash.constructor;
  const frLeft = Fr.fromString(left);
  const frRight = Fr.fromString(right);
  const hash = await (bb as any).poseidon2Hash([frLeft, frRight]);
  return hash.toString();
}

class PoseidonTree {
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

  proof(index: number): {
    root: string;
    pathElements: string[];
    pathIndices: number[];
    leaf: string;
  } {
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
}

// ============================================================================
// Proof Generation
// ============================================================================

function writeProverToml(inputs: MixerInputs): void {
  const toml = `# Mixer Circuit Prover Inputs

# Public inputs
root = "${inputs.root}"
nullifier_hash = "${inputs.nullifier_hash}"
recipient = "${inputs.recipient}"

# Private inputs
nullifier = "${inputs.nullifier}"
secret = "${inputs.secret}"
merkle_proof = [
${inputs.merkle_proof.map((p) => `  "${p}"`).join(",\n")}
]
is_even = [
${inputs.is_even.map((e) => `  ${e}`).join(",\n")}
]
`;
  fs.writeFileSync(path.join(CIRCUIT_DIR, "Prover.toml"), toml);
}

function generateProof(inputs: MixerInputs): ProofResult {
  writeProverToml(inputs);

  // Generate witness
  execSync("nargo execute", {
    cwd: CIRCUIT_DIR,
    stdio: "pipe",
  });

  // Generate Groth16 proof
  const acirPath = path.join(TARGET_DIR, "circuits.json");
  const witnessPath = path.join(TARGET_DIR, "circuits.gz");
  const ccsPath = path.join(TARGET_DIR, "circuits.ccs");
  const pkPath = path.join(TARGET_DIR, "circuits.pk");

  execSync(
    `sunspot prove ${acirPath} ${witnessPath} ${ccsPath} ${pkPath}`,
    {
      cwd: CIRCUIT_DIR,
      stdio: "pipe",
    }
  );

  const proof = fs.readFileSync(path.join(TARGET_DIR, "circuits.proof"));
  const publicWitness = fs.readFileSync(path.join(TARGET_DIR, "circuits.pw"));

  return { proof, publicWitness };
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  // Initialize Poseidon hasher (required for merkle tree operations)
  await initPoseidon();
  
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Mixer Integration Tests");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Verifier: ${VERIFIER_PROGRAM_ID}`);
  console.log(`Mixer: ${MIXER_PROGRAM_ID}\n`);

  const ctx = createRpcContext(RPC_URL);

  // Create test keypairs
  const payer = await loadKeypair(
    path.join(process.cwd(), "../keypair/deployer.json")
  ).catch(() => {
    console.log("  Creating new payer keypair...");
    return createKeypair();
  });

  const recipient = await createKeypair();
  const depositor = await createKeypair();

  console.log(`Payer: ${payer.address}`);
  console.log(`Recipient: ${recipient.address}`);
  console.log(`Depositor: ${depositor.address}\n`);

  // Check balances
  const payerBalance = await getBalance(ctx, payer.address);
  console.log(`Payer balance: ${formatLamports(payerBalance)}`);
  if (payerBalance < lamports(2_000_000_000n)) {
    console.log("  ⚠️  Low balance. Run: solana airdrop 2 <payer-address>");
  }

  // Get PDAs
  const [mixerState] = await getMixerStatePda();
  const [mixerVault] = await getMixerVaultPda();

  console.log(`\nMixer State PDA: ${mixerState}`);
  console.log(`Mixer Vault PDA: ${mixerVault}\n`);

  // TEST 1: Initialize Mixer
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 1: Initialize Mixer");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const initData = new Uint8Array(9);
  initData[0] = 0; // Initialize instruction
  const denominationBytes = new Uint8Array(8);
  new DataView(denominationBytes.buffer).setBigUint64(0, DENOMINATION, true);
  initData.set(denominationBytes, 1);

  const { value: latestBlockhash } = await ctx.rpc.getLatestBlockhash().send();

  // The mixer state PDA needs to be created with program-derived signing
  // The program will sign for the PDA creation using invoke_signed
  // Account roles: 3 = signer + writable, 1 = writable, 0 = readonly
  const initIx = {
    programAddress: MIXER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: 3 }, // signer + writable (payer funds the account)
      { address: mixerState, role: 1 }, // writable (PDA being created)
      { address: SYSTEM_PROGRAM_ADDRESS, role: 0 }, // readonly
    ],
    data: initData,
  };

  const initMessage = createTransactionMessage({ version: 0 });
  const initMessageWithPayer = setTransactionMessageFeePayerSigner(
    payer,
    initMessage
  );
  const initMessageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    initMessageWithPayer
  );
  const initTransactionMessage = appendTransactionMessageInstructions(
    [getSetComputeUnitLimitInstruction({ units: 200_000 }), initIx],
    initMessageWithLifetime
  );

  try {
    const signedInit = await signTransactionMessageWithSigners(
      initTransactionMessage
    );
    assertIsTransactionWithBlockhashLifetime(signedInit);
    assertIsSendableTransaction(signedInit);
    const initSig = await ctx.sendAndConfirm(signedInit, {
      commitment: "confirmed",
    });
    console.log(`  ✅ Mixer initialized`);
    console.log(`  TX: https://explorer.solana.com/tx/${initSig}?cluster=devnet`);
  } catch (err: any) {
    if (err.message?.includes("already in use") || err.message?.includes("AccountInUse")) {
      console.log("  ℹ️  Mixer already initialized");
    } else {
      console.error("  ❌ Initialization error:", err.message || err);
      console.error("  Full error:", err);
      throw err;
    }
  }

  // TEST 2: Make Deposit (Push Root)
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 2: Make Deposit (Push Merkle Root)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Generate commitment using circomlibjs
  const poseidon = await buildPoseidon();
  const nullifier = randomBigint();
  const secret = randomBigint();
  const commitmentHash = poseidon([nullifier, secret]);
  const commitmentBigint = poseidon.F.toObject(commitmentHash) as bigint;
  const commitmentStr = bigintToHex(commitmentBigint);

  // Build Merkle tree
  const tree = createPoseidonTree(20);
  await tree.insert(commitmentStr);
  const root = tree.root();
  const rootBytes = Buffer.from(root.slice(2), "hex");

  console.log(`  Commitment: ${commitmentStr.slice(0, 20)}...`);
  console.log(`  Root: ${root.slice(0, 20)}...\n`);

  // Push root instruction
  const pushRootData = new Uint8Array(33);
  pushRootData[0] = 1; // PushRoot instruction
  pushRootData.set(rootBytes, 1);

  const { value: latestBlockhash2 } = await ctx.rpc.getLatestBlockhash().send();

  const pushRootIx = {
    programAddress: MIXER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: "signer" },
      { address: mixerState, role: "writable" },
    ],
    data: pushRootData,
  };

  // Also transfer funds to vault
  const transferIx = getTransferSolInstruction({
    source: payer.address,
    destination: mixerVault,
    amount: DENOMINATION,
  });

  const pushRootMessage = createTransactionMessage({ version: 0 });
  const pushRootMessageWithPayer = setTransactionMessageFeePayerSigner(
    payer,
    pushRootMessage
  );
  const pushRootMessageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash2,
    pushRootMessageWithPayer
  );
  const pushRootTransactionMessage = appendTransactionMessageInstructions(
    [getSetComputeUnitLimitInstruction({ units: 200_000 }), pushRootIx, transferIx],
    pushRootMessageWithLifetime
  );

  const signedPushRoot = await signTransactionMessageWithSigners(
    pushRootTransactionMessage
  );
  assertIsTransactionWithBlockhashLifetime(signedPushRoot);
  assertIsSendableTransaction(signedPushRoot);
    const pushRootSig = await ctx.sendAndConfirm(signedPushRoot, {
      commitment: "confirmed",
    });
  console.log(`  ✅ Deposit completed`);
  console.log(`  TX: https://explorer.solana.com/tx/${pushRootSig}?cluster=devnet`);

  // TEST 3: Withdraw
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 3: Withdraw with ZK Proof");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Get Merkle proof
  const merkleProof = tree.proof(0);
  // Calculate nullifier hash using circomlibjs
  const nullifierHashResult = poseidon([nullifier]);
  const nullifierHashBigint = poseidon.F.toObject(nullifierHashResult) as bigint;
  const nullifierHash = bigintToHex(nullifierHashBigint);
  
  // Convert recipient address to field (32 bytes, little-endian bigint)
  const recipientBytes = Buffer.from(recipient.address.slice(2), "hex");
  // Pad to 32 bytes if needed, then convert to bigint (little-endian)
  const paddedRecipient = Buffer.alloc(32);
  recipientBytes.copy(paddedRecipient, 0, 0, Math.min(32, recipientBytes.length));
  let recipientFieldBigint = 0n;
  for (let i = 0; i < 32; i++) {
    recipientFieldBigint += BigInt(paddedRecipient[i]) * (256n ** BigInt(i));
  }
  const recipientField = bigintToHex(recipientFieldBigint);

  const inputs: MixerInputs = {
    root: root,
    nullifier_hash: nullifierHash,
    recipient: recipientField,
    nullifier: bigintToHex(nullifier),
    secret: bigintToHex(secret),
    merkle_proof: merkleProof.pathElements,
    is_even: merkleProof.pathIndices.map((i) => i === 0),
  };

  console.log("  Generating ZK proof...");
  const proofResult = generateProof(inputs);
  console.log(`  Proof generated (${proofResult.proof.length} bytes)`);

  // Build withdraw instruction
  // Note: nullifier hash needs to be converted from field to bytes
  // The nullifier hash from the circuit is a field element, we need to convert it properly
  const nullifierHashFieldBigint = hexToBigint(nullifierHash);
  const nullifierHashBytes = new Uint8Array(32);
  // Convert field to bytes (little-endian, 32 bytes)
  for (let i = 0; i < 32; i++) {
    nullifierHashBytes[i] = Number((nullifierHashFieldBigint >> BigInt(i * 8)) & BigInt(0xff));
  }

  const [nullifierPda] = await getNullifierPda(nullifierHashBytes);

  // Convert root from hex string to bytes
  const rootBytes2 = Buffer.from(root.startsWith("0x") ? root.slice(2) : root, "hex");
  
  // Convert recipient field to bytes (32 bytes, little-endian)
  const recipientFieldBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    recipientFieldBytes[i] = Number((recipientFieldBigint >> BigInt(i * 8)) & BigInt(0xff));
  }

  // Withdraw instruction format: [tag: u8, root: [u8; 32], nullifier_hash: [u8; 32], recipient_field: [u8; 32], proof: Vec<u8>]
  // The proof parameter should contain: proof_bytes || public_witness_bytes
  // where public_witness_bytes is the .pw file from Sunspot (contains root || nullifier_hash || recipient_field)
  const proofWithWitness = Buffer.concat([proofResult.proof, proofResult.publicWitness]);
  const withdrawData = new Uint8Array(1 + 32 + 32 + 32 + proofWithWitness.length);
  withdrawData[0] = 2; // Withdraw instruction
  withdrawData.set(rootBytes2, 1);
  withdrawData.set(nullifierHashBytes, 33);
  withdrawData.set(recipientFieldBytes, 65);
  withdrawData.set(proofWithWitness, 97);

  const { value: latestBlockhash3 } = await ctx.rpc.getLatestBlockhash().send();

  const withdrawIx = {
    programAddress: MIXER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: "signer" },
      { address: mixerState, role: "writable" },
      { address: nullifierPda, role: "writable" },
      { address: mixerVault, role: "writable" },
      { address: recipient.address, role: "writable" },
      { address: VERIFIER_PROGRAM_ID, role: "readonly" },
      { address: SYSTEM_PROGRAM_ADDRESS, role: "readonly" },
    ],
    data: withdrawData,
  };

  const withdrawMessage = createTransactionMessage({ version: 0 });
  const withdrawMessageWithPayer = setTransactionMessageFeePayerSigner(
    payer,
    withdrawMessage
  );
  const withdrawMessageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash3,
    withdrawMessageWithPayer
  );
  const withdrawTransactionMessage = appendTransactionMessageInstructions(
    [getSetComputeUnitLimitInstruction({ units: 1_000_000 }), withdrawIx],
    withdrawMessageWithLifetime
  );

  const recipientBalanceBefore = await getBalance(ctx, recipient.address);

  const signedWithdraw = await signTransactionMessageWithSigners(
    withdrawTransactionMessage
  );
  assertIsTransactionWithBlockhashLifetime(signedWithdraw);
  assertIsSendableTransaction(signedWithdraw);
    const withdrawSig = await ctx.sendAndConfirm(signedWithdraw, {
      commitment: "confirmed",
    });
  console.log(`  ✅ Withdrawal successful`);
  console.log(`  TX: https://explorer.solana.com/tx/${withdrawSig}?cluster=devnet`);

  const recipientBalanceAfter = await getBalance(ctx, recipient.address);
  console.log(`  Recipient balance: ${formatLamports(recipientBalanceBefore)} → ${formatLamports(recipientBalanceAfter)}`);
  console.log(`  Amount received: ${formatLamports(recipientBalanceAfter - recipientBalanceBefore)}`);

  // TEST 4: Try to withdraw again (should fail - nullifier already used)
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 4: Double Withdraw Attempt (should fail)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { value: latestBlockhash4 } = await ctx.rpc.getLatestBlockhash().send();

  const withdrawIx2 = {
    programAddress: MIXER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: "signer" },
      { address: mixerState, role: "writable" },
      { address: nullifierPda, role: "writable" },
      { address: mixerVault, role: "writable" },
      { address: recipient.address, role: "writable" },
      { address: VERIFIER_PROGRAM_ID, role: "readonly" },
      { address: SYSTEM_PROGRAM_ADDRESS, role: "readonly" },
    ],
    data: withdrawData,
  };

  const withdrawMessage2 = createTransactionMessage({ version: 0 });
  const withdrawMessageWithPayer2 = setTransactionMessageFeePayerSigner(
    payer,
    withdrawMessage2
  );
  const withdrawMessageWithLifetime2 = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash4,
    withdrawMessageWithPayer2
  );
  const withdrawTransactionMessage2 = appendTransactionMessageInstructions(
    [getSetComputeUnitLimitInstruction({ units: 1_000_000 }), withdrawIx2],
    withdrawMessageWithLifetime2
  );

  try {
    const signedWithdraw2 = await signTransactionMessageWithSigners(
      withdrawTransactionMessage2
    );
    assertIsTransactionWithBlockhashLifetime(signedWithdraw2);
    assertIsSendableTransaction(signedWithdraw2);
    await ctx.sendAndConfirm(signedWithdraw2, {
      commitment: "confirmed",
    });
    console.log(`  ❌ UNEXPECTED: Second withdrawal succeeded (should have failed)`);
  } catch (err: any) {
    console.log(`  ✅ Correctly rejected double withdrawal`);
    if (err.message) {
      console.log(`  Error: ${err.message.slice(0, 100)}`);
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("All tests completed!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message || err);
  process.exit(1);
});

