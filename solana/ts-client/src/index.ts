import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

/**
 * This client is intentionally minimal and focuses on wiring for the mixer
 * and verifier programs. Proof generation is delegated to the Sunspot CLI
 * and Noir toolchain, mirroring the pipeline described in
 * `solana-foundation/noir-examples` and the Sunspot repository.
 *
 * High level:
 * 1. Use `nargo` + Sunspot to generate a proof and public inputs for the
 *    mixer Noir circuit (`circuits/src/main.nr`).
 * 2. Serialize `proof_bytes || public_witness_bytes` exactly as the
 *    Sunspot verifier expects.
 * 3. Build a `Withdraw` instruction for the `mixer` program with:
 *      - root
 *      - nullifier_hash
 *      - recipient_field
 *      - proof
 * 4. Submit a transaction containing the mixer `Withdraw` ix and any
 *    required funding/transfers.
 */

export interface MixerAddresses {
  mixerProgramId: PublicKey;
  verifierProgramId: PublicKey;
  mixerState: PublicKey;
  mixerVault: PublicKey;
}

export function buildWithdrawInstruction(opts: {
  addresses: MixerAddresses;
  root: Uint8Array; // 32 bytes
  nullifierHash: Uint8Array; // 32 bytes
  recipientField: Uint8Array; // 32 bytes
  proof: Uint8Array; // Groth16 proof bytes from Sunspot
  nullifierAccount: PublicKey;
  recipient: PublicKey;
  relayer: PublicKey;
}): TransactionInstruction {
  const { addresses, root, nullifierHash, recipientField, proof, nullifierAccount, recipient, relayer } = opts;

  if (root.length !== 32 || nullifierHash.length !== 32 || recipientField.length !== 32) {
    throw new Error("root/nullifierHash/recipientField must be 32 bytes each");
  }

  // MixerInstruction::Withdraw tag = 2
  const data = new Uint8Array(1 + 32 + 32 + 32 + proof.length);
  data[0] = 2;
  data.set(root, 1);
  data.set(nullifierHash, 1 + 32);
  data.set(recipientField, 1 + 64);
  data.set(proof, 1 + 96);

  const keys = [
    { pubkey: relayer, isSigner: true, isWritable: false },
    { pubkey: addresses.mixerState, isSigner: false, isWritable: true },
    { pubkey: nullifierAccount, isSigner: false, isWritable: true },
    { pubkey: addresses.mixerVault, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: addresses.verifierProgramId, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: addresses.mixerProgramId,
    keys,
    data,
  });
}

export async function getLatestRoot(connection: Connection, mixerState: PublicKey): Promise<Uint8Array> {
  const account = await connection.getAccountInfo(mixerState);
  if (!account) {
    throw new Error("mixer state account not found");
  }
  const data = account.data;
  // denomination: u64 (8 bytes) + roots[0..29]*32 + current_root_index: u8
  const currentRootIndex = data[8 + 32 * 30];
  const start = 8 + currentRootIndex * 32;
  return data.slice(start, start + 32);
}



