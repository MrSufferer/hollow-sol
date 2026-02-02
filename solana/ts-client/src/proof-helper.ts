// Proof generation helper using Sunspot CLI
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface ProofResult {
  proof: Buffer;
  publicWitness: Buffer;
}

export interface CircuitConfig {
  circuitDir: string;
  circuitName: string;
}

export interface MixerInputs {
  root: string;
  nullifier_hash: string;
  recipient: string;
  nullifier: string;
  secret: string;
  merkle_proof: string[];
  is_even: boolean[];
}

function getTargetDir(config: CircuitConfig): string {
  return path.join(config.circuitDir, "target");
}

function getProverTomlPath(config: CircuitConfig): string {
  return path.join(config.circuitDir, "Prover.toml");
}

function getWitnessPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.gz`);
}

function getAcirPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.json`);
}

function getCcsPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.ccs`);
}

function getProvingKeyPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.pk`);
}

function getProofPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.proof`);
}

function getPublicWitnessPath(config: CircuitConfig): string {
  return path.join(getTargetDir(config), `${config.circuitName}.pw`);
}

export function writeProverToml(config: CircuitConfig, inputs: MixerInputs): void {
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
  fs.writeFileSync(getProverTomlPath(config), toml);
}

export function generateWitness(config: CircuitConfig): void {
  execSync("nargo execute", {
    cwd: config.circuitDir,
    stdio: "pipe",
  });
}

export function generateGroth16Proof(config: CircuitConfig): void {
  const acirPath = getAcirPath(config);
  const witnessPath = getWitnessPath(config);
  const ccsPath = getCcsPath(config);
  const pkPath = getProvingKeyPath(config);

  execSync(
    `sunspot prove ${acirPath} ${witnessPath} ${ccsPath} ${pkPath}`,
    {
      cwd: config.circuitDir,
      stdio: "pipe",
    }
  );
}

export function readProofFiles(config: CircuitConfig): ProofResult {
  const proof = fs.readFileSync(getProofPath(config));
  const publicWitness = fs.readFileSync(getPublicWitnessPath(config));
  return { proof, publicWitness };
}

export function generateProof(
  config: CircuitConfig,
  inputs: MixerInputs
): ProofResult {
  writeProverToml(config, inputs);
  generateWitness(config);
  generateGroth16Proof(config);
  return readProofFiles(config);
}

export function createInstructionData(proofResult: ProofResult): Buffer {
  return Buffer.concat([proofResult.proof, proofResult.publicWitness]);
}

