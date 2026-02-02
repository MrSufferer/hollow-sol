# Mixer Integration Tests

Integration tests for the Solana mixer program using Noir + Sunspot.

## Prerequisites

- Solana CLI configured for devnet
- Noir 1.0.0-beta.18 installed
- Sunspot built and available in PATH
- Mixer program deployed to devnet
- Verifier program deployed (program ID: `D9YEdaR4MT37wUP1GZ1CmrirMtRsegG7gibX3rLb7sgD`)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
export MIXER_PROGRAM_ID=<your-mixer-program-id>
export RPC_URL=https://api.devnet.solana.com
```

3. Ensure deployer keypair exists:
```bash
mkdir -p keypair
solana-keygen new --outfile keypair/deployer.json --no-bip39-passphrase -s
solana airdrop 2 $(solana address -k keypair/deployer.json) --url devnet
```

## Running Tests

```bash
npm run test
```

## Test Coverage

1. **Initialize Mixer**: Creates mixer state account with denomination
2. **Make Deposit**: Pushes Merkle root and transfers funds to vault
3. **Withdraw**: Generates ZK proof and successfully withdraws funds
4. **Double Withdraw Prevention**: Attempts second withdrawal with same nullifier (should fail)

## Notes

- Tests use real devnet transactions
- Requires sufficient SOL balance in deployer account
- Proof generation uses Sunspot CLI (must be in PATH)
- Merkle tree uses Poseidon2 hashing (compatible with circuit)

