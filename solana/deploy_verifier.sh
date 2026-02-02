#!/bin/bash
# Script to deploy Solana verifier program
# Requires: GNARK_VERIFIER_BIN environment variable set

export GNARK_VERIFIER_BIN=/tmp/sunspot/gnark-solana/crates/verifier-bin

if [ ! -f "target/circuits.vk" ]; then
    echo "Error: circuits.vk not found. Run 'sunspot setup' first."
    exit 1
fi

echo "Generating Solana verifier program..."
/tmp/sunspot/go/sunspot deploy target/circuits.vk

if [ -f "target/circuits.so" ]; then
    echo "✅ Verifier program generated: target/circuits.so"
    echo ""
    echo "To deploy to devnet:"
    echo "  solana program deploy target/circuits.so --url devnet"
else
    echo "⚠️  Verifier program generation may have failed. Check output above."
fi
