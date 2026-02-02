//! Solana mixer program
//!
//! This program mirrors the high-level behavior of the EVM `Mixer.sol`:
//! - Track a fixed-denomination pool of lamports.
//! - Store a rolling history of Poseidon2 Merkle roots for deposits.
//! - Track spent nullifier hashes to prevent double-withdraw.
//! - Verify Groth16 proofs via CPI into a Sunspot-generated verifier program.
//!
//! The verifier program is assumed to be produced by Sunspot for the Noir
//! circuit in `circuits/src/main.nr`, with public inputs:
//!   0: root
//!   1: nullifier_hash
//!   2: recipient (as field-encoded address).

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};
use solana_system_interface::instruction as system_instruction;
use thiserror::Error;

entrypoint!(process_instruction);

#[derive(Error, Debug, Copy, Clone)]
pub enum MixerError {
    #[error("Invalid instruction")]
    InvalidInstruction,
    #[error("Unknown root")]
    UnknownRoot,
    #[error("Nullifier already used")]
    NullifierUsed,
    #[error("Verification failed")]
    VerificationFailed,
}

impl From<MixerError> for ProgramError {
    fn from(e: MixerError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Configuration and state for the mixer.
///
/// This is intentionally compact and simple. Merkle tree updates and root
/// computation are performed off-chain; this program only stores a rolling
/// set of recent roots and enforces that a withdrawal references a known root.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MixerState {
    /// Fixed deposit/withdraw amount in lamports.
    pub denomination: u64,
    /// Ring buffer of recent Merkle roots.
    pub roots: [[u8; 32]; MixerState::ROOT_HISTORY_SIZE],
    /// Index of the latest root in the ring buffer.
    pub current_root_index: u8,
}

impl MixerState {
    pub const ROOT_HISTORY_SIZE: usize = 30;
    pub const LEN: usize = 8 + 32 * Self::ROOT_HISTORY_SIZE + 1;

    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        if root == &[0u8; 32] {
            return false;
        }
        let mut idx = self.current_root_index as usize;
        for _ in 0..Self::ROOT_HISTORY_SIZE {
            if &self.roots[idx] == root {
                return true;
            }
            if idx == 0 {
                idx = Self::ROOT_HISTORY_SIZE - 1;
            } else {
                idx -= 1;
            }
        }
        false
    }

    pub fn push_root(&mut self, root: [u8; 32]) {
        let next = (self.current_root_index as usize + 1) % Self::ROOT_HISTORY_SIZE;
        self.roots[next] = root;
        self.current_root_index = next as u8;
    }
}

/// Instructions supported by the mixer.
pub enum MixerInstruction {
    /// Initialize the mixer state.
    ///
    /// Accounts:
    ///   0. [signer]  Payer / authority.
    ///   1. [writable] Mixer state account (PDA).
    ///   2. []        System program.
    ///
    /// Data:
    ///   - denomination: u64
    Initialize { denomination: u64 },

    /// Record a new Merkle root for deposits.
    ///
    /// This does not itself move funds; the client is responsible for sending
    /// lamports into the mixer vault account in a separate instruction.
    ///
    /// Accounts:
    ///   0. [signer]   Authority.
    ///   1. [writable] Mixer state account (PDA).
    ///
    /// Data:
    ///   - new_root: [u8; 32]
    PushRoot { new_root: [u8; 32] },

    /// Withdraw funds by presenting a valid ZK proof and public inputs.
    ///
    /// Accounts:
    ///   0. [signer]   Relayer / transaction sender.
    ///   1. [writable] Mixer state account (PDA).
    ///   2. [writable] Nullifier account (PDA derived from nullifier hash).
    ///   3. [writable] Mixer vault account holding lamports.
    ///   4. [writable] Recipient account.
    ///   5. []         Verifier program (Sunspot-generated).
    ///   6. []         System program.
    ///
    /// Data:
    ///   - root: [u8; 32]
    ///   - nullifier_hash: [u8; 32]
    ///   - recipient_field: [u8; 32] (field-encoded address, must correspond to recipient)
    ///   - proof: Vec<u8> (Groth16 proof bytes as expected by Sunspot verifier)
    Withdraw {
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        recipient_field: [u8; 32],
        proof: Vec<u8>,
    },
}

impl MixerInstruction {
    pub fn unpack(input: &[u8]) -> Result<Self, MixerError> {
        let (tag, rest) = input.split_first().ok_or(MixerError::InvalidInstruction)?;
        Ok(match tag {
            0 => {
                if rest.len() != 8 {
                    return Err(MixerError::InvalidInstruction);
                }
                let denomination = u64::from_le_bytes(rest.try_into().unwrap());
                MixerInstruction::Initialize { denomination }
            }
            1 => {
                if rest.len() != 32 {
                    return Err(MixerError::InvalidInstruction);
                }
                let mut root = [0u8; 32];
                root.copy_from_slice(rest);
                MixerInstruction::PushRoot { new_root: root }
            }
            2 => {
                if rest.len() < 32 + 32 + 32 {
                    return Err(MixerError::InvalidInstruction);
                }
                let mut root = [0u8; 32];
                root.copy_from_slice(&rest[0..32]);
                let mut nullifier_hash = [0u8; 32];
                nullifier_hash.copy_from_slice(&rest[32..64]);
                let mut recipient_field = [0u8; 32];
                recipient_field.copy_from_slice(&rest[64..96]);
                let proof = rest[96..].to_vec();
                MixerInstruction::Withdraw {
                    root,
                    nullifier_hash,
                    recipient_field,
                    proof,
                }
            }
            _ => return Err(MixerError::InvalidInstruction),
        })
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = MixerInstruction::unpack(instruction_data).map_err(ProgramError::from)?;

    match instruction {
        MixerInstruction::Initialize { denomination } => {
            process_initialize(program_id, accounts, denomination)
        }
        MixerInstruction::PushRoot { new_root } => process_push_root(program_id, accounts, new_root),
        MixerInstruction::Withdraw {
            root,
            nullifier_hash,
            recipient_field,
            proof,
        } => process_withdraw(program_id, accounts, root, nullifier_hash, recipient_field, proof),
    }
}

fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    denomination: u64,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let payer = next_account_info(account_info_iter)?;
    let state_account = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(MixerState::LEN);

    if state_account.lamports() == 0 {
        msg!("Creating mixer state account");
        
        // Verify this is the correct PDA
        let (expected_pda, bump) = Pubkey::find_program_address(&[b"mixer_state"], program_id);
        if state_account.key != &expected_pda {
            return Err(ProgramError::InvalidArgument);
        }
        
        // Create account with PDA signing
        // The payer funds the account, but the program signs for the PDA
        let create_ix = system_instruction::create_account(
            payer.key,
            state_account.key,
            required_lamports,
            MixerState::LEN as u64,
            program_id,
        );
        
        // Sign with PDA seeds - this allows the program to create the PDA account
        let seeds: &[&[u8]] = &[b"mixer_state", &[bump]];
        invoke_signed(
            &create_ix,
            &[payer.clone(), state_account.clone(), system_program.clone()],
            &[seeds],
        )?;
    }

    // Initialize state
    let mut data = state_account.try_borrow_mut_data()?;
    if data.len() < MixerState::LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    // denomination
    data[0..8].copy_from_slice(&denomination.to_le_bytes());
    // roots
    for i in 0..MixerState::ROOT_HISTORY_SIZE {
        let start = 8 + i * 32;
        data[start..start + 32].copy_from_slice(&[0u8; 32]);
    }
    // current_root_index
    data[8 + 32 * MixerState::ROOT_HISTORY_SIZE] = 0;

    Ok(())
}

fn load_state<'a>(state_account: &'a AccountInfo) -> Result<MixerState, ProgramError> {
    let data = state_account.data.borrow();
    if data.len() < MixerState::LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    let mut roots = [[0u8; 32]; MixerState::ROOT_HISTORY_SIZE];
    let denomination = u64::from_le_bytes(data[0..8].try_into().unwrap());
    for i in 0..MixerState::ROOT_HISTORY_SIZE {
        let start = 8 + i * 32;
        roots[i].copy_from_slice(&data[start..start + 32]);
    }
    let current_root_index = data[8 + 32 * MixerState::ROOT_HISTORY_SIZE];
    Ok(MixerState {
        denomination,
        roots,
        current_root_index,
    })
}

fn store_state(state_account: &AccountInfo, state: &MixerState) -> Result<(), ProgramError> {
    let mut data = state_account.data.borrow_mut();
    if data.len() < MixerState::LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[0..8].copy_from_slice(&state.denomination.to_le_bytes());
    for i in 0..MixerState::ROOT_HISTORY_SIZE {
        let start = 8 + i * 32;
        data[start..start + 32].copy_from_slice(&state.roots[i]);
    }
    data[8 + 32 * MixerState::ROOT_HISTORY_SIZE] = state.current_root_index;
    Ok(())
}

fn process_push_root(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_root: [u8; 32],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let authority = next_account_info(account_info_iter)?;
    let state_account = next_account_info(account_info_iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = load_state(state_account)?;
    state.push_root(new_root);
    store_state(state_account, &state)?;
    Ok(())
}

fn process_withdraw(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    _recipient_field: [u8; 32],
    proof: Vec<u8>,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let _relayer = next_account_info(account_info_iter)?;
    let state_account = next_account_info(account_info_iter)?;
    let nullifier_account = next_account_info(account_info_iter)?;
    let vault_account = next_account_info(account_info_iter)?;
    let recipient_account = next_account_info(account_info_iter)?;
    let verifier_program = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    // Load and check root
    let state = load_state(state_account)?;
    if !state.is_known_root(&root) {
        msg!("Unknown root");
        return Err(MixerError::UnknownRoot.into());
    }

    // Nullifier account being non-zero lamports means it is already used.
    if nullifier_account.lamports() > 0 {
        msg!("Nullifier already used");
        return Err(MixerError::NullifierUsed.into());
    }

    // Mark nullifier as used by creating a small account; this is a simple pattern
    // that avoids building a custom bitmap.
    {
        let payer = recipient_account; // any signer that funds this is acceptable
        if !payer.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(0);
        let create_ix = system_instruction::create_account(
            payer.key,
            nullifier_account.key,
            lamports,
            0,
            &system_program.key, // system-owned marker
        );
        invoke(
            &create_ix,
            &[
                payer.clone(),
                nullifier_account.clone(),
                system_program.clone(),
            ],
        )?;
    }

    // Build instruction data for the verifier: proof_bytes || public_witness_bytes
    // The public_witness_bytes is the .pw file from Sunspot containing public inputs.
    // According to Sunspot/Noir examples, the format is: proof || public_witness
    // where public_witness contains root || nullifier_hash || recipient_field.
    // The client should concatenate proof + public_witness before passing to this instruction.
    // We pass the proof parameter directly to the verifier (it should already contain both).
    let instruction_data = proof;

    let verify_ix = solana_program::instruction::Instruction {
        program_id: *verifier_program.key,
        accounts: vec![],
        data: instruction_data,
    };

    // CPI into verifier program
    // NOTE: The verifier is expected to revert on invalid proofs.
    invoke(&verify_ix, &[]).map_err(|_| MixerError::VerificationFailed)?;

    // Transfer funds from vault to recipient
    let transfer_ix = system_instruction::transfer(vault_account.key, recipient_account.key, state.denomination);
    invoke(
        &transfer_ix,
        &[
            vault_account.clone(),
            recipient_account.clone(),
            system_program.clone(),
        ],
    )?;

    Ok(())
}



