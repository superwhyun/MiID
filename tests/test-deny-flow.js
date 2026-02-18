#!/usr/bin/env node
/**
 * Test: Deny Flow
 */

const h = require('./test-helpers');

async function testDenyFlow() {
  await h.runTest('Deny Flow', async () => {
    // Step 1: Create wallet
    h.logStep(1, 'Create test wallet');
    const wallet = await h.createWallet('deny-test-wallet');
    h.logSuccess(`Wallet created: ${wallet.did}`);

    // Step 2: Create challenge
    h.logStep(2, 'Create authentication challenge');
    const challenge = await h.createChallenge({ didHint: wallet.did });
    h.assertNotNull(challenge.challenge_id, 'Challenge ID should exist');
    h.logSuccess(`Challenge created: ${challenge.challenge_id}`);

    // Step 3: Deny the challenge
    h.logStep(3, 'Deny the challenge');
    const denial = await h.denyChallenge(challenge.challenge_id, wallet.did);
    h.assertEqual(denial.status, 200, 'Denial should succeed');
    h.assertEqual(denial.data.status, 'denied', 'Status should be denied');
    h.logSuccess('Challenge denied');

    // Step 4: Verify status
    h.logStep(4, 'Verify challenge is denied');
    const status = await h.getChallengeStatus(challenge.challenge_id);
    h.assertEqual(status.data.status, 'denied', 'Status should be denied');
    h.assertNotNull(status.data.denied_at, 'denied_at should exist');
    h.logSuccess('Status confirmed as denied');

    // Step 5: Attempt approval after denial
    h.logStep(5, 'Attempt approval after denial (should fail)');
    const signature = await h.signChallenge(
      wallet.did,
      challenge.challenge_id,
      challenge.nonce,
      h.DEFAULT_CLIENT_ID,
      challenge.expires_at,
      {
        serviceId: h.DEFAULT_SERVICE_ID,
        requestedClaims: challenge.requested_claims || [],
        approvedClaims: challenge.requested_claims || []
      }
    );
    const approval = await h.approveChallenge(challenge.challenge_id, wallet.did, signature.signature);
    h.assertEqual(approval.status, 409, 'Approval should fail with 409');
    h.assertEqual(approval.data.error, 'challenge_not_pending', 'Error should be challenge_not_pending');
    h.logSuccess('Approval correctly rejected');

    h.logInfo('Deny flow completed successfully!');
  });
}

testDenyFlow().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
