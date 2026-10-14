/**
 * Port for confirming a team's service code is a real one (design F, R01):
 * the three-character code that attributes the team's AI use to its service
 * for chargeback. No authoritative source is agreed yet - CDP and the Cloud
 * Centre of Excellence each hold part of the picture - so the only adapter
 * today is the mock, which checks the codes an environment is told about.
 * A real adapter implements the same shape and is selected by config.
 *
 * @typedef {object} ServiceCodeVerification
 * @property {boolean} verified - whether the code was confirmed against a source
 * @property {string|null} source - what confirmed it, null when nothing could
 *
 * @typedef {object} ServiceCodeVerifier
 * @property {(serviceCode: string) => Promise<ServiceCodeVerification>} verify - never throws for an unknown code; an unverified code is a fact about the code, not a failure
 */

export {}
