import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
export function buildWithdrawInstruction(opts) {
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
export async function getLatestRoot(connection, mixerState) {
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
