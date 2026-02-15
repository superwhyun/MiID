#!/usr/bin/env node
/**
 * Test: Normal Login Flow
 */

const h = require('./test-helpers');

async function testLoginFlow() {
  await h.runTest('Normal Login Flow', async () => {
    // Step 1: Create wallet
    h.logStep(1, 'Create test wallet');
    const wallet = await h.createWallet('login-test-wallet');
    h.logSuccess(`Wallet created: ${wallet.did}`);

    // Step 2: Create challenge
    h.logStep(2, 'Create authentication challenge');
    const challenge = await h.createChallenge({ didHint: wallet.did });
    h.assertNotNull(challenge.challenge_id, 'Challenge ID should exist');
    h.assertNotNull(challenge.nonce, 'Nonce should exist');
    h.logSuccess(`Challenge created: ${challenge.challenge_id}`);

    // Step 3: Check initial status
    h.logStep(3, 'Verify challenge is pending');
    const status1 = await h.getChallengeStatus(challenge.challenge_id);
    h.assertEqual(status1.data.status, 'pending', 'Initial status should be pending');
    h.logSuccess('Status is pending');

    // Step 4: Sign and approve
    h.logStep(4, 'Sign challenge and approve');
    const signature = await h.signChallenge(
      wallet.did,
      challenge.challenge_id,
      challenge.nonce,
      h.DEFAULT_CLIENT_ID,
      challenge.expires_at
    );
    h.assertNotNull(signature.signature, 'Signature should exist');

    const approval = await h.approveChallenge(challenge.challenge_id, wallet.did, signature.signature);
    h.assertEqual(approval.status, 200, 'Approval should succeed');
    h.assertNotNull(approval.data.authorization_code, 'Authorization code should exist');
    h.logSuccess(`Approved with code: ${approval.data.authorization_code}`);

    // Step 5: Check verified status
    h.logStep(5, 'Verify challenge is verified');
    const status2 = await h.getChallengeStatus(challenge.challenge_id);
    h.assertEqual(status2.data.status, 'verified', 'Status should be verified');
    h.logSuccess('Status is verified');

    // Step 6: Exchange token
    h.logStep(6, 'Exchange authorization code for tokens');
    const tokenResult = await h.exchangeToken(approval.data.authorization_code);
    h.assertEqual(tokenResult.status, 200, 'Token exchange should succeed');
    h.assertNotNull(tokenResult.data.access_token, 'Access token should exist');
    h.assertNotNull(tokenResult.data.refresh_token, 'Refresh token should exist');
    h.logSuccess('Tokens obtained');

    // Step 7: Get profile
    h.logStep(7, 'Retrieve user profile');
    const profile = await h.getServiceProfile(h.DEFAULT_SERVICE_ID, tokenResult.data.access_token);
    h.assertEqual(profile.status, 200, 'Profile request should succeed');
    h.assertEqual(profile.data.did, wallet.did, 'Profile DID should match');
    h.logSuccess(`Profile retrieved for: ${profile.data.subject_id}`);

    // Step 8: Check session
    h.logStep(8, 'Verify active session exists');
    const sessions = await h.getWalletSessions(wallet.did);
    h.assertEqual(sessions.status, 200, 'Sessions request should succeed');
    h.assertTrue(sessions.data.sessions.length > 0, 'Should have at least one session');
    h.logSuccess(`Active sessions: ${sessions.data.sessions.length}`);

    h.logInfo('Login flow completed successfully!');
  });
}

testLoginFlow().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
