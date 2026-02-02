use dep::poseidon::poseidon::bn254::hash_2 as poseidon_hash_2;
mod merkle_tree;
fn main(
    // Public inputs
    root: pub Field,
    nullifier_hash: pub Field,
    recipient: pub Field,

    // Private inputs
    nullifier: Field,
    secret: Field,
    merkle_proof: [Field; 20],
    is_even: [bool; 20],
) {
    // compute the commitment Poseidon(nullifier, secret)
    let commitment: Field = poseidon_hash_2([nullifier, secret]);

    // check that the nullifier matches the nullifier hash
    // For single element, we hash with zero
    let computed_nullifier_hash: Field = poseidon_hash_2([nullifier, 0]);
    assert(computed_nullifier_hash == nullifier_hash);
    
    // check that the commitment is in the Merkle tree
    let computed_root: Field = merkle_tree::compute_merkle_root(commitment, merkle_proof, is_even);
    assert(computed_root == root);

    // let recipient_binding = recipient * recipient;
    // assert(recipient_binding == recipient * recipient);
}