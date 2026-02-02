#!/bin/bash
# Deploy Mixer Program to Solana Devnet
#
# Usage:
#   ./deploy-mixer.sh [program-id-keypair]
#
# If program-id-keypair is not provided, a new keypair will be generated.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYPAIR_DIR="$SCRIPT_DIR/keypair"
PROGRAM_SO="$SCRIPT_DIR/target/deploy/mixer.so"
NETWORK="${NETWORK:-devnet}"

# Check if program is built
if [ ! -f "$PROGRAM_SO" ]; then
    echo "Error: Program not found at $PROGRAM_SO"
    echo "Run 'cargo-build-sbf' first to build the program."
    exit 1
fi

# Create keypair directory if it doesn't exist
mkdir -p "$KEYPAIR_DIR"

# Generate or use provided program keypair
if [ -n "$1" ]; then
    PROGRAM_KEYPAIR="$1"
else
    PROGRAM_KEYPAIR="$KEYPAIR_DIR/mixer.json"
    if [ ! -f "$PROGRAM_KEYPAIR" ]; then
        echo "Generating new program keypair..."
        solana-keygen new --outfile "$PROGRAM_KEYPAIR" --no-bip39-passphrase -s
    fi
fi

PROGRAM_ID=$(solana address -k "$PROGRAM_KEYPAIR")
echo "Program ID: $PROGRAM_ID"

# Check for deployer keypair
DEPLOYER_KEYPAIR="$KEYPAIR_DIR/deployer.json"
if [ ! -f "$DEPLOYER_KEYPAIR" ]; then
    echo "Error: Deployer keypair not found at $DEPLOYER_KEYPAIR"
    echo "Create a keypair with: solana-keygen new --outfile $DEPLOYER_KEYPAIR"
    exit 1
fi

# Check deployer balance
DEPLOYER_BALANCE=$(solana balance -k "$DEPLOYER_KEYPAIR" --url "$NETWORK" | grep -oP '\d+\.\d+' | head -1)
if (( $(echo "$DEPLOYER_BALANCE < 2.0" | bc -l) )); then
    echo "Warning: Deployer balance is low ($DEPLOYER_BALANCE SOL)"
    echo "Airdrop with: solana airdrop 2 -k $DEPLOYER_KEYPAIR --url $NETWORK"
fi

echo ""
echo "Deploying mixer program to $NETWORK..."
echo "Program ID: $PROGRAM_ID"
echo ""

# Deploy the program
solana program deploy "$PROGRAM_SO" \
    --url "$NETWORK" \
    --program-id "$PROGRAM_KEYPAIR" \
    --keypair "$DEPLOYER_KEYPAIR"

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Program ID: $PROGRAM_ID"
echo "Update your integration tests with:"
echo "  export MIXER_PROGRAM_ID=$PROGRAM_ID"
echo ""
echo "Or update the test file:"
echo "  MIXER_PROGRAM_ID=$PROGRAM_ID npm run test"

