use dep::poseidon::poseidon::bn254::hash_2 as poseidon_hash_2;

pub fn compute_merkle_root(
    leaf: Field,
    merkle_proof: [Field; 20],
    is_even: [bool; 20],
) -> Field {
    // temporary variable to store the hash for the current level we are working on
    let mut hash: Field = leaf;
    // increment through the levels
    for i in 0..20 {
        let (left, right) = if is_even[i] {
            (hash, merkle_proof[i])
        } else {
            (merkle_proof[i], hash)
        };
        // compute the hash for the current level
        hash = poseidon_hash_2([left, right]);
    }
    // return the root of the Merkle tree
    hash
}