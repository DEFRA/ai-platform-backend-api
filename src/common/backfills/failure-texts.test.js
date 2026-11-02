import { currentFailureText } from '#/common/backfills/failure-texts.js'

describe('currentFailureText', () => {
  test.each([
    [
      'The change has not progressed in time and platform engineers have been alerted',
      'The setup did not finish in time'
    ],
    [
      'The apply failed and platform engineers have been alerted',
      'The deployment failed'
    ],
    [
      'The apply failed again after a fresh retry, so the change was reverted',
      'The deployment failed again after a fresh retry, so the change was reverted'
    ],
    [
      'The apply failed and the revert was cancelled; platform engineers have been alerted',
      'The deployment failed and the revert was cancelled'
    ],
    [
      'The apply failed again after a fresh retry and reverting the change failed too, so platform engineers have been alerted',
      'The deployment failed again after a fresh retry and reverting the change failed too'
    ]
  ])('rewrites %s', (old, current) => {
    expect(currentFailureText(old, 'op-abcde12345')).toBe(current)
  })

  test('rewrites a failed removal with the support reference of its operation', () => {
    expect(
      currentFailureText(
        'The model could not be removed, so it is still deployed; platform engineers have been alerted',
        'op-abcde12345'
      )
    ).toBe(
      'The model could not be removed, so it is still deployed. Contact AI Platform Support, quoting reference AIP-12345'
    )
  })

  test('takes Azure and the old advice out of a verification text', () => {
    expect(
      currentFailureText(
        "Your team's resources were created but could not be confirmed: a resource could not be found in Azure (resource-unavailable). Ask the AI Platform team to check and retry.",
        'op-1'
      )
    ).toBe(
      "Your team's resources were created but could not be confirmed: a resource could not be found (resource-unavailable)."
    )
  })

  test.each([
    'The setup did not finish in time',
    'The file failed validation',
    ''
  ])('leaves %j as it is', (text) => {
    expect(currentFailureText(text, 'op-1')).toBeNull()
  })
})
