#!/usr/bin/env node
/**
 * Test: Session Revoke Flow
 */

const h = require('./test-helpers');

async function testRevokeFlow() {
  await h.runTest('Session Revoke Flow', async () => {
    // Step 1: Complete login to get active session
    h.logStep(1, 'Create wallet and complete login');
    const wallet = await h.createWallet('revoke-test-wallet');
    const challenge = await h.createChallenge({ didHint: wallet.did });
    const signature = await h.signChallenge(
      wallet.did,
      challenge.challenge_id,
      challenge.nonce,
      h.DEFAULT_CLIENT_ID,
      challenge.expires_at
    );
    const approval = await h.approveChallenge(challenge.challenge_id, wallet.did, signature.signature);
    const tokenResult = await h.exchangeToken(approval.data.authorization_code);
    h.logSuccess(`Session created with token: ${tokenResult.data.access_token.substring(0, 20)}...`);

    // Step 2: Verify session is active
    h.logStep(2, 'Verify active session');
    const sessions1 = await h.getWalletSessions(wallet.did);
    h.assertTrue(sessions1.data.sessions.length > 0, 'Should have active session');
    const sessionId = sessions1.data.sessions[0].session_id;
    h.logSuccess(`Active session: ${sessionId}`);

    // Step 3: Verify profile access works
    h.logStep(3, 'Verify profile access works');
    const profile1 = await h.getServiceProfile(h.DEFAULT_SERVICE_ID, tokenResult.data.access_token);
    h.assertEqual(profile1.status, 200, 'Profile should be accessible');
    h.logSuccess('Profile accessible');

    // Step 4: Revoke session
    h.logStep(4, 'Revoke session');
    const revoke = await h.revokeSession(sessionId, wallet.did);
    h.assertEqual(revoke.status, 200, 'Revoke should succeed');
    h.assertEqual(revoke.data.status, 'revoked', 'Status should be revoked');
    h.logSuccess('Session revoked');

    // Step 5: Verify session is removed
    h.logStep(5, 'Verify session is removed from active list');
    const sessions2 = await h.getWalletSessions(wallet.did);
    const stillActive = sessions2.data.sessions.find(s => s.session_id === sessionId);
    h.assertTrue(!stillActive, 'Session should not be in active list');
    h.logSuccess('Session removed from active list');

    // Step 6: Verify token is invalid
    h.logStep(6, 'Verify token is invalidated');
    const profile2 = await h.getServiceProfile(h.DEFAULT_SERVICE_ID, tokenResult.data.access_token);
    h.assertEqual(profile2.status, 401, 'Profile should be inaccessible');
    h.logSuccess('Token correctly invalidated');

    h.logInfo('Revoke flow completed successfully!');
  });
}

testRevokeFlow().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
