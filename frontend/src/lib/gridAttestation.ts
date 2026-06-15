import type { GridAttestationEvidence, GridAttestationVerification, HexAddress } from './gridTypes';

type VerifyGridAttestationArgs = {
  attestation: GridAttestationEvidence;
  authorizedGridExecutors: HexAddress[];
  approvedCodeHash: string;
  approvedDeploymentHash?: string;
  now?: Date;
};

function normalize(value: string) {
  return value.toLowerCase();
}

export function verifyGridAttestation({
  attestation,
  authorizedGridExecutors,
  approvedCodeHash,
  approvedDeploymentHash,
  now = new Date(),
}: VerifyGridAttestationArgs): GridAttestationVerification {
  const failures: string[] = [];
  const { identity, evidence } = attestation;

  if (identity.status !== 'active') {
    failures.push(`Encryption identity is ${identity.status}, not active.`);
  }

  if (normalize(identity.processorAddress) !== normalize(evidence.processorAddress)) {
    failures.push('Processor address does not match attestation evidence.');
  }

  if (normalize(identity.codeHash) !== normalize(evidence.codeHash)) {
    failures.push('Identity code hash does not match attestation evidence.');
  }

  if (normalize(identity.deploymentHash) !== normalize(evidence.deploymentHash)) {
    failures.push('Identity deployment hash does not match attestation evidence.');
  }

  if (normalize(identity.codeHash) !== normalize(approvedCodeHash)) {
    failures.push('Processor code hash is not approved for grid execution.');
  }

  if (approvedDeploymentHash && normalize(identity.deploymentHash) !== normalize(approvedDeploymentHash)) {
    failures.push('Processor deployment hash is not approved for grid execution.');
  }

  const isAuthorized = authorizedGridExecutors.some((executor) => normalize(executor) === normalize(identity.processorAddress));
  if (!isAuthorized) {
    failures.push('Processor is not authorized as GRID_EXECUTOR in ExecutorRegistry.');
  }

  if (identity.validUntil && now > new Date(identity.validUntil)) {
    failures.push('Encryption identity has expired.');
  }

  if (evidence.expiresAt && now > new Date(evidence.expiresAt)) {
    failures.push('Attestation evidence has expired.');
  }

  return {
    verified: failures.length === 0,
    failures,
  };
}
