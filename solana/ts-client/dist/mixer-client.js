// Mixer program client utilities
import { getProgramDerivedAddress, } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
const textEncoder = new TextEncoder();
export async function getMixerStatePda(mixerProgramId) {
    const [pda, bump] = await getProgramDerivedAddress({
        programAddress: mixerProgramId,
        seeds: [textEncoder.encode("mixer_state")],
    });
    return [pda, bump];
}
export async function getMixerVaultPda(mixerProgramId) {
    const [pda, bump] = await getProgramDerivedAddress({
        programAddress: mixerProgramId,
        seeds: [textEncoder.encode("mixer_vault")],
    });
    return [pda, bump];
}
export async function getNullifierPda(mixerProgramId, nullifierHash) {
    const [pda, bump] = await getProgramDerivedAddress({
        programAddress: mixerProgramId,
        seeds: [textEncoder.encode("nullifier"), nullifierHash],
    });
    return [pda, bump];
}
export async function getMixerAddresses(mixerProgramId, verifierProgramId) {
    const [mixerState] = await getMixerStatePda(mixerProgramId);
    const [mixerVault] = await getMixerVaultPda(mixerProgramId);
    return {
        mixerProgramId,
        verifierProgramId,
        mixerState,
        mixerVault,
    };
}
export function buildInitializeInstruction(addresses, denomination, payer) {
    const data = new Uint8Array(9);
    data[0] = 0; // Initialize instruction
    const denominationBytes = new Uint8Array(8);
    new DataView(denominationBytes.buffer).setBigUint64(0, denomination, true);
    data.set(denominationBytes, 1);
    return {
        programAddress: addresses.mixerProgramId,
        accounts: [
            { address: payer, role: "signer" },
            { address: addresses.mixerState, role: "writable" },
            { address: SYSTEM_PROGRAM_ADDRESS, role: "readonly" },
        ],
        data,
    };
}
export function buildPushRootInstruction(addresses, root, authority) {
    const data = new Uint8Array(33);
    data[0] = 1; // PushRoot instruction
    data.set(root, 1);
    return {
        programAddress: addresses.mixerProgramId,
        accounts: [
            { address: authority, role: "signer" },
            { address: addresses.mixerState, role: "writable" },
        ],
        data,
    };
}
export function buildWithdrawInstruction(addresses, root, nullifierHash, recipientField, proofWithWitness, nullifierPda, recipient, relayer) {
    if (root.length !== 32 || nullifierHash.length !== 32 || recipientField.length !== 32) {
        throw new Error("root/nullifierHash/recipientField must be 32 bytes each");
    }
    const data = new Uint8Array(1 + 32 + 32 + 32 + proofWithWitness.length);
    data[0] = 2; // Withdraw instruction
    data.set(root, 1);
    data.set(nullifierHash, 33);
    data.set(recipientField, 65);
    data.set(proofWithWitness, 97);
    return {
        programAddress: addresses.mixerProgramId,
        accounts: [
            { address: relayer, role: "signer" },
            { address: addresses.mixerState, role: "writable" },
            { address: nullifierPda, role: "writable" },
            { address: addresses.mixerVault, role: "writable" },
            { address: recipient, role: "writable" },
            { address: addresses.verifierProgramId, role: "readonly" },
            { address: SYSTEM_PROGRAM_ADDRESS, role: "readonly" },
        ],
        data,
    };
}
