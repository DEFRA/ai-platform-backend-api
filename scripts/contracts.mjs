// `npm run contracts:sync -- {ref}` vendors the message schemas from
// ai-platform-infra; `npm run contracts:check` fails when the vendored copy
// differs from the ref in src/contracts/aip-gitops/VERSION.
import {
  checkContracts,
  syncContracts
} from '../src/contracts/contracts-sync.js'

const [command, ref] = process.argv.slice(2)

try {
  if (command === 'sync') {
    const files = await syncContracts({ ref })

    console.log(`Synced ${files.join(', ')} at ${ref}`)
  } else if (command === 'check') {
    const { ref: version, differing } = await checkContracts()

    if (differing.length > 0) {
      console.error(
        `The vendored contracts differ from ai-platform-infra at ${version}: ${differing.join(', ')}. Run npm run contracts:sync -- ${version}`
      )
      process.exit(1)
    }

    console.log(`The vendored contracts match ai-platform-infra at ${version}`)
  } else {
    console.error('Usage: contracts.mjs sync {ref} | check')
    process.exit(2)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
