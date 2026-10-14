/**
 * Mock TenantResourceVerifier for `PROVISIONING_MODE=mock`: confirms every
 * team's resources without calling Azure.
 * @type {import('./tenant-resource-verifier.js').TenantResourceVerifier}
 */
export const mockTenantResourceVerifier = {
  async verify() {
    return { verified: true }
  }
}
